import { UnrecoverableError, Worker } from "bullmq";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getRedisConnection, type ProcessThreadsReplyJob } from "@/lib/queue/client";
import {
  ThreadsApiError,
  createThreadsReplyContainer,
  getThreadsContainerStatus,
  publishThreadsReplyContainer,
} from "@/lib/threads/client";

export async function processThreadsReplyJob(
  data: ProcessThreadsReplyJob
): Promise<void> {
  const log = await prisma.threadsReplyLog.findUnique({
    where: { id: data.threadsReplyLogId },
    include: {
      threadsAccount: {
        select: { threadsUserId: true, accessToken: true },
      },
    },
  });
  if (!log || log.status === "SENT") return;

  try {
    const accessToken = decryptToken(log.threadsAccount.accessToken);
    let containerId = log.publishContainerId;
    if (!containerId) {
      containerId = await createThreadsReplyContainer(
        accessToken,
        log.threadsAccount.threadsUserId,
        data.replyId,
        data.replyMessage
      );
      await prisma.threadsReplyLog.update({
        where: { id: log.id },
        data: { publishContainerId: containerId },
      });
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

    const publishedReplyId =
      container.status === "PUBLISHED"
        ? log.publishedReplyId
        : await publishThreadsReplyContainer(
            accessToken,
            log.threadsAccount.threadsUserId,
            containerId
          );
    await prisma.threadsReplyLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        publishedReplyId,
        replySentAt: new Date(),
        errorMessage: null,
        attempts: { increment: 1 },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.threadsReplyLog.update({
      where: { id: log.id },
      data: {
        status: "FAILED",
        errorMessage: message.slice(0, 500),
        attempts: { increment: 1 },
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
