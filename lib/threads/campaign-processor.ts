import { prisma } from "@/lib/db/client";
import { getThreadsReplyQueue } from "@/lib/queue/client";
import type { ThreadsReply } from "@/lib/threads/client";
import { isOwnThreadsReply, normalizeThreadsReply } from "@/lib/threads/replies";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

type TransactionOutcome =
  | { kind: "seen" }
  | { kind: "no_match" }
  | {
      kind: "matched";
      logId: string;
      campaignId: string;
      replyMessage: string;
    };

export async function processObservedThreadsReply(input: {
  threadsAccountId: string;
  rootPostId: string;
  reply: ThreadsReply;
  source: "WEBHOOK" | "POLLING";
}): Promise<"queued" | "self" | "seen" | "no_match"> {
  const account = await prisma.threadsAccount.findUnique({
    where: { id: input.threadsAccountId },
    select: { threadsUserId: true, workspaceId: true },
  });
  if (!account) return "seen";
  if (isOwnThreadsReply(input.reply, account.threadsUserId)) return "self";

  const normalized = normalizeThreadsReply(input.reply);
  const outcome: TransactionOutcome = await prisma.$transaction(
    async (transaction) => {
      const claim = await transaction.processedThreadsReply.createMany({
        data: {
          threadsAccountId: input.threadsAccountId,
          replyId: input.reply.id,
          source: input.source,
        },
        skipDuplicates: true,
      });
      if (claim.count === 0) return { kind: "seen" };

      const campaigns = await transaction.threadsCampaign.findMany({
        where: {
          threadsAccountId: input.threadsAccountId,
          isActive: true,
          OR: [
            { matchAnyPost: true },
            {
              matchAnyPost: false,
              postId: input.rootPostId,
              postVerifiedAt: { not: null },
            },
          ],
        },
        orderBy: [
          { matchAnyPost: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });

      for (const campaign of campaigns) {
        if (
          !normalized.timestamp ||
          !campaign.activatedAt ||
          normalized.timestamp <= campaign.activatedAt
        ) {
          continue;
        }
        const match = matchKeywords(
          normalized.text,
          campaign.keywords,
          campaign.wholeWordMatch,
        );
        if (!match.matched) continue;

        const log = await transaction.threadsReplyLog.create({
          data: {
            workspaceId: account.workspaceId,
            threadsCampaignId: campaign.id,
            threadsAccountId: input.threadsAccountId,
            replyId: normalized.id,
            replyAuthorId: normalized.authorId,
            replyAuthorName: normalized.authorName,
            replyText: normalized.text,
            replyMessage: campaign.replyMessage,
            matchedKeyword: match.matchedKeyword,
          },
        });

        return {
          kind: "matched",
          logId: log.id,
          campaignId: campaign.id,
          replyMessage: campaign.replyMessage,
        } as const;
      }

      return { kind: "no_match" };
    },
  );

  if (outcome.kind === "seen") return "seen";
  if (outcome.kind === "no_match") return "no_match";

  await getThreadsReplyQueue().add(
    "publish-thread-reply",
    {
      threadsAccountId: input.threadsAccountId,
      threadsCampaignId: outcome.campaignId,
      threadsReplyLogId: outcome.logId,
      replyId: normalized.id,
      replyMessage: outcome.replyMessage,
    },
    {
      jobId: `threads_${input.threadsAccountId}_${normalized.id}_${outcome.campaignId}`,
    },
  );
  return "queued";
}
