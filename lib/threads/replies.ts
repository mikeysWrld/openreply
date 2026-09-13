import type { ThreadsReply } from "@/lib/threads/client";

export interface NormalizedThreadsReply {
  id: string;
  text: string;
  authorId: string | null;
  authorName: string | null;
  rootPostId: string | null;
  parentReplyId: string | null;
  ownedByMe: boolean;
  timestamp: Date | null;
}

export function isOwnThreadsReply(
  reply: ThreadsReply,
  connectedUserId: string,
  connectedUsername?: string | null,
): boolean {
  if (reply.is_reply_owned_by_me === true || reply.owner?.id === connectedUserId) {
    return true;
  }

  const normalizeUsername = (username: string) =>
    username.trim().replace(/^@/, "").toLowerCase();

  return Boolean(
    reply.username &&
      connectedUsername &&
      normalizeUsername(reply.username) === normalizeUsername(connectedUsername),
  );
}

export function normalizeThreadsReply(
  reply: ThreadsReply
): NormalizedThreadsReply {
  const timestamp = reply.timestamp ? new Date(reply.timestamp) : null;
  return {
    id: reply.id,
    text: reply.text ?? "",
    authorId: reply.owner?.id ?? null,
    authorName: reply.username ?? null,
    rootPostId: reply.root_post?.id ?? null,
    parentReplyId: reply.replied_to?.id ?? null,
    ownedByMe: reply.is_reply_owned_by_me === true,
    timestamp: timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null,
  };
}
