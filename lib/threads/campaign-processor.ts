import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getThreadsReplyQueue } from "@/lib/queue/client";
import type { ThreadsReply } from "@/lib/threads/client";
import { isOwnThreadsReply, normalizeThreadsReply } from "@/lib/threads/replies";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

class ProcessedThreadsReplyAlreadyClaimedError extends Error {}

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
  let selected:
    | {
        logId: string;
        campaignId: string;
        replyMessage: string;
      }
    | null;

  try {
    selected = await prisma.$transaction(async (transaction) => {
      try {
        await transaction.processedThreadsReply.create({
          data: {
            threadsAccountId: input.threadsAccountId,
            replyId: input.reply.id,
            source: input.source,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new ProcessedThreadsReplyAlreadyClaimedError();
        }
        throw error;
      }

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
          logId: log.id,
          campaignId: campaign.id,
          replyMessage: campaign.replyMessage,
        };
      }

      return null;
    });
  } catch (error) {
    if (error instanceof ProcessedThreadsReplyAlreadyClaimedError) {
      return "seen";
    }
    throw error;
  }

  if (!selected) return "no_match";

  await getThreadsReplyQueue().add(
    "publish-thread-reply",
    {
      threadsAccountId: input.threadsAccountId,
      threadsCampaignId: selected.campaignId,
      threadsReplyLogId: selected.logId,
      replyId: normalized.id,
      replyMessage: selected.replyMessage,
    },
    {
      jobId: `threads_${input.threadsAccountId}_${normalized.id}_${selected.campaignId}`,
    },
  );
  return "queued";
}
