import type { ThreadsReply } from "@/lib/threads/client";

export interface NormalizedThreadsReply {
  id: string;
  text: string;
  authorId: string | null;
  authorName: string | null;
  rootPostId: string | null;
  parentReplyId: string | null;
  ownedByMe: boolean;
}

export function isOwnThreadsReply(
  reply: ThreadsReply,
  connectedUserId: string
): boolean {
  return reply.is_reply_owned_by_me === true || reply.owner?.id === connectedUserId;
}

export function normalizeThreadsReply(
  reply: ThreadsReply
): NormalizedThreadsReply {
  return {
    id: reply.id,
    text: reply.text ?? "",
    authorId: reply.owner?.id ?? null,
    authorName: reply.username ?? null,
    rootPostId: reply.root_post?.id ?? null,
    parentReplyId: reply.replied_to?.id ?? null,
    ownedByMe: reply.is_reply_owned_by_me === true,
  };
}
