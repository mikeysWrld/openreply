import { UnrecoverableError, Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getRedisConnection, type ProcessThreadsReplyJob } from "@/lib/queue/client";
import {
  ThreadsApiError,
  createThreadsReplyContainer,
  getThreadsContainerStatus,
  publishThreadsReplyContainer,
} from "@/lib/threads/client";
import { getThreadsRequestTimeoutMs } from "@/lib/threads/fetch";

const MIN_PUBLISH_LEASE_MS = 2 * 60_000;

function publishLeaseDurationMs(): number {
  return Math.max(
    MIN_PUBLISH_LEASE_MS,
    getThreadsRequestTimeoutMs() * 3 + 30_000
  );
}

export async function processThreadsReplyJob(
  data: ProcessThreadsReplyJob
): Promise<void> {
  const log = await prisma.threadsReplyLog.findUnique({
    where: { id: data.threadsReplyLogId },
    include: {
      threadsAccount: {
        select: { threadsUserId: true, accessToken: true },
      },
      threadsCampaign: {
        select: { isActive: true },
      },
    },
  });
  if (!log || log.status !== "PENDING" || !log.threadsCampaign.isActive) return;

  const leaseToken = randomUUID();
  const now = new Date();
  const claimed = await prisma.threadsReplyLog.updateMany({
    where: {
      id: log.id,
      status: "PENDING",
      OR: [
        { publishLeaseToken: null },
        { publishLeaseExpiresAt: null },
        { publishLeaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      publishLeaseToken: leaseToken,
      publishLeaseExpiresAt: new Date(now.getTime() + publishLeaseDurationMs()),
    },
  });
  if (claimed.count === 0) return;

  const claimedLog = await prisma.threadsReplyLog.findUnique({
    where: { id: log.id },
    include: {
      threadsAccount: {
        select: { threadsUserId: true, accessToken: true },
      },
      threadsCampaign: {
        select: { isActive: true },
      },
    },
  });
  if (!claimedLog || !claimedLog.threadsCampaign.isActive) return;

  try {
    let accessToken: string;
    try {
      accessToken = decryptToken(claimedLog.threadsAccount.accessToken);
    } catch {
      throw new UnrecoverableError("Unable to decrypt Threads access token");
    }
    let containerId = claimedLog.publishContainerId;
    if (!containerId) {
      containerId = await createThreadsReplyContainer(
        accessToken,
        claimedLog.threadsAccount.threadsUserId,
        data.replyId,
        data.replyMessage
      );
      const persisted = await prisma.threadsReplyLog.updateMany({
        where: { id: claimedLog.id, publishLeaseToken: leaseToken },
        data: { publishContainerId: containerId },
      });
      if (persisted.count === 0) return;
    }

    const container = await getThreadsContainerStatus(accessToken, containerId);
    if (container.status === "IN_PROGRESS") {
      throw new ThreadsApiError(
        `Threads reply container ${containerId} is still in progress`,
        409,
        null,
        true
      );
    }
    if (container.status === "ERROR" || container.status === "EXPIRED") {
      const detail = container.error_message
        ? `: ${container.error_message}`
        : "";
      throw new UnrecoverableError(
        `Threads reply container ${containerId} is ${container.status.toLowerCase()}${detail}`
      );
    }

    let publishedReplyId = claimedLog.publishedReplyId;
    if (container.status === "FINISHED") {
      const renewed = await prisma.threadsReplyLog.updateMany({
        where: { id: claimedLog.id, publishLeaseToken: leaseToken },
        data: {
          publishLeaseExpiresAt: new Date(
            Date.now() + publishLeaseDurationMs()
          ),
        },
      });
      if (renewed.count === 0) return;
      publishedReplyId = await publishThreadsReplyContainer(
        accessToken,
        claimedLog.threadsAccount.threadsUserId,
        containerId
      );
    } else if (container.status !== "PUBLISHED") {
      throw new ThreadsApiError(
        "Threads API returned an invalid container status",
        502,
        null,
        true
      );
    }
    await prisma.threadsReplyLog.updateMany({
      where: { id: claimedLog.id, publishLeaseToken: leaseToken },
      data: {
        status: "SENT",
        publishedReplyId,
        replySentAt: new Date(),
        errorMessage: null,
        attempts: { increment: 1 },
        publishLeaseToken: null,
        publishLeaseExpiresAt: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const terminal =
      error instanceof UnrecoverableError ||
      (error instanceof ThreadsApiError && !error.retryable);
    await prisma.threadsReplyLog.updateMany({
      where: { id: claimedLog.id, publishLeaseToken: leaseToken },
      data: {
        status: terminal ? "FAILED" : "PENDING",
        errorMessage: message.slice(0, 500),
        attempts: { increment: 1 },
        publishLeaseToken: null,
        publishLeaseExpiresAt: null,
      },
    });
    if (error instanceof ThreadsApiError && !error.retryable) {
      throw new UnrecoverableError(message);
    }
    throw error;
  }
}

export function createThreadsReplyWorker() {
  return new Worker<ProcessThreadsReplyJob>(
    "threads-reply-processing",
    (job) => processThreadsReplyJob(job.data),
    { connection: getRedisConnection(), concurrency: 2 }
  );
}
