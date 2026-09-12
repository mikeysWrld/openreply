import { Worker } from "bullmq";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getRedisConnection, type ProcessThreadsReplyJob } from "@/lib/queue/client";
import { publishThreadsReply } from "@/lib/threads/client";

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
    const publishedReplyId = await publishThreadsReply(
      decryptToken(log.threadsAccount.accessToken),
      log.threadsAccount.threadsUserId,
      data.replyId,
      data.replyMessage
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
