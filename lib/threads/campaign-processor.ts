import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getThreadsReplyQueue } from "@/lib/queue/client";
import type { ThreadsReply } from "@/lib/threads/client";
import { isOwnThreadsReply, normalizeThreadsReply } from "@/lib/threads/replies";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

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

  try {
    await prisma.processedThreadsReply.create({
      data: {
        threadsAccountId: input.threadsAccountId,
        replyId: input.reply.id,
        source: input.source,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "seen";
    }
    throw error;
  }

  const campaigns = await prisma.threadsCampaign.findMany({
    where: {
      threadsAccountId: input.threadsAccountId,
      isActive: true,
      OR: [
        { matchAnyPost: true },
        { matchAnyPost: false, postId: input.rootPostId },
      ],
    },
    orderBy: [
      { matchAnyPost: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
  const normalized = normalizeThreadsReply(input.reply);
  for (const campaign of campaigns) {
    const match = matchKeywords(
      normalized.text,
      campaign.keywords,
      campaign.wholeWordMatch
    );
    if (!match.matched) continue;
    const log = await prisma.threadsReplyLog.create({
      data: {
        workspaceId: account.workspaceId,
        threadsCampaignId: campaign.id,
        threadsAccountId: input.threadsAccountId,
        replyId: normalized.id,
        replyAuthorId: normalized.authorId,
        replyAuthorName: normalized.authorName,
        replyText: normalized.text,
        matchedKeyword: match.matchedKeyword,
      },
    });
    await getThreadsReplyQueue().add(
      "publish-thread-reply",
      {
        threadsAccountId: input.threadsAccountId,
        threadsCampaignId: campaign.id,
        threadsReplyLogId: log.id,
        replyId: normalized.id,
        replyMessage: campaign.replyMessage,
      },
      { jobId: `threads_${input.threadsAccountId}_${normalized.id}_${campaign.id}` }
    );
    return "queued";
  }
  return "no_match";
}
