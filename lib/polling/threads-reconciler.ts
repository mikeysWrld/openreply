import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { processObservedThreadsReply } from "@/lib/threads/campaign-processor";
import { getThreadsConversation } from "@/lib/threads/client";

export async function reconcileThreadsReplies(): Promise<{
  conversations: number;
  observed: number;
}> {
  const campaigns = await prisma.threadsCampaign.findMany({
    where: { isActive: true },
    include: {
      threadsAccount: {
        select: { id: true, accessToken: true },
      },
    },
  });
  const max = Math.max(
    1,
    Number(process.env.THREADS_POLL_MAX_PER_SWEEP ?? 30)
  );
  const keys = new Set<string>();
  let conversations = 0;
  let observed = 0;

  for (const campaign of campaigns) {
    const key = `${campaign.threadsAccountId}:${campaign.postId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    try {
      const replies = await getThreadsConversation(
        decryptToken(campaign.threadsAccount.accessToken),
        campaign.postId,
        max
      );
      conversations += 1;
      for (const reply of replies.slice(-max)) {
        await processObservedThreadsReply({
          threadsAccountId: campaign.threadsAccountId,
          rootPostId: campaign.postId,
          reply,
          source: "POLLING",
        });
        observed += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Threads Poller] ${key}: ${message}`);
    }
  }
  return { conversations, observed };
}
