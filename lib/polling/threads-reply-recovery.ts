import { prisma } from "@/lib/db/client";
import { getThreadsReplyQueue } from "@/lib/queue/client";

const DEFAULT_RECOVERY_MAX_PER_SWEEP = 50;

function recoveryLimit(): number {
  const configured = process.env.THREADS_REPLY_RECOVERY_MAX_PER_SWEEP;
  if (configured === undefined) return DEFAULT_RECOVERY_MAX_PER_SWEEP;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RECOVERY_MAX_PER_SWEEP;
}

export async function recoverPendingThreadsReplies(): Promise<number> {
  const logs = await prisma.threadsReplyLog.findMany({
    where: {
      status: "PENDING",
      threadsCampaign: { isActive: true },
    },
    orderBy: { updatedAt: "asc" },
    take: recoveryLimit(),
    select: {
      id: true,
      threadsAccountId: true,
      threadsCampaignId: true,
      replyId: true,
      replyMessage: true,
      threadsCampaign: { select: { replyMessage: true } },
    },
  });
  let requeued = 0;
  const queue = getThreadsReplyQueue();
  for (const log of logs) {
    const jobId = `threads_${log.threadsAccountId}_${log.replyId}_${log.threadsCampaignId}`;
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "failed" || state === "completed") {
        await existingJob.remove();
      } else if (state !== "unknown") {
        continue;
      }
    }
    await queue.add(
      "publish-thread-reply",
      {
        threadsAccountId: log.threadsAccountId,
        threadsCampaignId: log.threadsCampaignId,
        threadsReplyLogId: log.id,
        replyId: log.replyId,
        replyMessage: log.replyMessage ?? log.threadsCampaign.replyMessage,
      },
      {
        jobId,
      }
    );
    requeued += 1;
  }
  return requeued;
}
