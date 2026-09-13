import { createHmac, timingSafeEqual } from "node:crypto";
import type { ThreadsReply } from "@/lib/threads/client";

export interface ThreadsWebhookReplyEvent {
  threadsUserId: string;
  rootPostId: string;
  reply: ThreadsReply;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

export function verifyThreadsWebhookSignature(
  rawBody: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const secret = process.env.THREADS_APP_SECRET;
  if (!secret) {
    throw new Error("THREADS_APP_SECRET environment variable is required");
  }

  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function parseReplyValue(value: unknown): ThreadsWebhookReplyEvent | null {
  if (!isRecord(value) || !isRecord(value.root_post)) return null;
  const id = nonEmptyString(value.id);
  const rootPostId = nonEmptyString(value.root_post.id);
  const threadsUserId = nonEmptyString(value.root_post.owner_id);
  if (!id || !rootPostId || !threadsUserId) return null;

  const reply: ThreadsReply = {
    id,
    root_post: { id: rootPostId },
  };
  for (const key of [
    "text",
    "timestamp",
    "permalink",
    "media_type",
    "shortcode",
    "username",
  ] as const) {
    if (typeof value[key] === "string") reply[key] = value[key];
  }
  if (isRecord(value.replied_to)) {
    const repliedToId = nonEmptyString(value.replied_to.id);
    if (repliedToId) reply.replied_to = { id: repliedToId };
  }
  if (isRecord(value.owner)) {
    const ownerId = nonEmptyString(value.owner.id);
    if (ownerId) reply.owner = { id: ownerId };
  }
  if (typeof value.is_reply === "boolean") {
    reply.is_reply = value.is_reply;
  }
  if (typeof value.is_reply_owned_by_me === "boolean") {
    reply.is_reply_owned_by_me = value.is_reply_owned_by_me;
  }

  return { threadsUserId, rootPostId, reply };
}

export function parseThreadsReplyEvents(
  payload: unknown,
): ThreadsWebhookReplyEvent[] {
  if (!isRecord(payload)) return [];
  const rawValues = Array.isArray(payload.values)
    ? payload.values
    : [payload.values];
  const events: ThreadsWebhookReplyEvent[] = [];

  for (const entry of rawValues) {
    if (!isRecord(entry) || entry.field !== "replies") continue;
    const event = parseReplyValue(entry.value);
    if (event) events.push(event);
  }
  return events;
}
