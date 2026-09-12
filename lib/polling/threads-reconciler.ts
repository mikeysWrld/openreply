import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { processObservedThreadsReply } from "@/lib/threads/campaign-processor";
import { recoverPendingThreadsReplies } from "@/lib/polling/threads-reply-recovery";
import {
  getOwnedThreads,
  getThreadsConversation,
} from "@/lib/threads/client";

interface ThreadsCampaignGroup {
  accountId: string;
  accessToken: string;
  campaigns: Array<{ postId: string | null; matchAnyPost: boolean }>;
}

interface ThreadsReconciliationResult {
  conversations: number;
  observed: number;
}

let activeSweep: Promise<ThreadsReconciliationResult> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

async function runThreadsReconciliation(): Promise<ThreadsReconciliationResult> {
  try {
    await recoverPendingThreadsReplies();
  } catch (error) {
    console.error(`[Threads Poller] reply recovery: ${errorMessage(error)}`);
  }
  const campaigns = await prisma.threadsCampaign.findMany({
    where: { isActive: true },
    select: {
      threadsAccountId: true,
      postId: true,
      matchAnyPost: true,
      threadsAccount: {
        select: { id: true, accessToken: true },
      },
    },
  });
  const maxReplies = positiveInteger(
    process.env.THREADS_POLL_MAX_PER_SWEEP,
    30
  );
  const maxPosts = positiveInteger(
    process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP,
    100
  );
  const groups = new Map<string, ThreadsCampaignGroup>();
  let conversations = 0;
  let observed = 0;

  for (const campaign of campaigns) {
    const existing = groups.get(campaign.threadsAccountId);
    if (existing) {
      existing.campaigns.push({
        postId: campaign.postId,
        matchAnyPost: campaign.matchAnyPost,
      });
    } else {
      groups.set(campaign.threadsAccountId, {
        accountId: campaign.threadsAccount.id,
        accessToken: campaign.threadsAccount.accessToken,
        campaigns: [
          {
            postId: campaign.postId,
            matchAnyPost: campaign.matchAnyPost,
          },
        ],
      });
    }
  }

  for (const group of groups.values()) {
    let token: string;
    try {
      token = decryptToken(group.accessToken);
    } catch (error) {
      console.error(
        `[Threads Poller] ${group.accountId} token: ${errorMessage(error)}`
      );
      continue;
    }

    const rootPostIds = new Set<string>();
    for (const campaign of group.campaigns) {
      if (campaign.postId) rootPostIds.add(campaign.postId);
    }

    if (group.campaigns.some((campaign) => campaign.matchAnyPost)) {
      try {
        const ownedPosts = await getOwnedThreads(token, maxPosts);
        for (const post of ownedPosts) rootPostIds.add(post.id);
      } catch (error) {
        console.error(
          `[Threads Poller] ${group.accountId} owned posts: ${errorMessage(error)}`
        );
      }
    }

    for (const rootPostId of rootPostIds) {
      try {
        const replies = await getThreadsConversation(
          token,
          rootPostId,
          maxReplies
        );
        conversations += 1;
        for (const reply of replies.slice(-maxReplies)) {
          await processObservedThreadsReply({
            threadsAccountId: group.accountId,
            rootPostId,
            reply,
            source: "POLLING",
          });
          observed += 1;
        }
      } catch (error) {
        console.error(
          `[Threads Poller] ${group.accountId}:${rootPostId}: ${errorMessage(error)}`
        );
      }
    }
  }
  return { conversations, observed };
}

export function reconcileThreadsReplies(): Promise<ThreadsReconciliationResult> {
  if (activeSweep) return activeSweep;

  const sweep = runThreadsReconciliation();
  activeSweep = sweep;
  void sweep.then(
    () => {
      if (activeSweep === sweep) activeSweep = null;
    },
    () => {
      if (activeSweep === sweep) activeSweep = null;
    }
  );
  return sweep;
}
