import { Worker } from "bullmq";
import { prisma } from "@/lib/db/client";
import {
  getRedisConnection,
  type ProcessThreadsWebhookJob,
} from "@/lib/queue/client";
import { processObservedThreadsReply } from "@/lib/threads/campaign-processor";

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown error").slice(
    0,
    500,
  );
}

export async function processThreadsWebhookJob(
  data: ProcessThreadsWebhookJob,
): Promise<void> {
  const accounts = new Map<string, { id: string } | null>();

  try {
    for (const event of data.events) {
      let account = accounts.get(event.threadsUserId);
      if (account === undefined) {
        account = await prisma.threadsAccount.findUnique({
          where: { threadsUserId: event.threadsUserId },
          select: { id: true },
        });
        accounts.set(event.threadsUserId, account);
      }
      if (!account) continue;

      await processObservedThreadsReply({
        threadsAccountId: account.id,
        rootPostId: event.rootPostId,
        reply: event.reply,
        source: "WEBHOOK",
      });
    }

    await prisma.webhookEvent.update({
      where: { id: data.webhookEventId },
      data: {
        status: "PROCESSED",
        errorMessage: null,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.webhookEvent
      .update({
        where: { id: data.webhookEventId },
        data: {
          status: "FAILED",
          errorMessage: errorMessage(error),
          processedAt: new Date(),
        },
      })
      .catch(() => {});
    throw error;
  }
}

export function createThreadsWebhookWorker() {
  return new Worker<ProcessThreadsWebhookJob>(
    "threads-webhook-processing",
    (job) => processThreadsWebhookJob(job.data),
    { connection: getRedisConnection(), concurrency: 4 },
  );
}
