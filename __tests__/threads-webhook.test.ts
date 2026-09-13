import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseThreadsReplyEvents,
  verifyThreadsWebhookSignature,
} from "../lib/threads/webhook";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("THREADS_APP_SECRET", "threads-secret");
});

describe("verifyThreadsWebhookSignature", () => {
  it("accepts a payload signed by the Threads app secret", () => {
    const rawBody = JSON.stringify({ app_id: "app_1" });
    const signature = `sha256=${createHmac("sha256", "threads-secret")
      .update(rawBody)
      .digest("hex")}`;

    expect(verifyThreadsWebhookSignature(rawBody, signature)).toBe(true);
  });

  it.each([null, "", "sha256=wrong", "wrong-format"])(
    "rejects a missing or invalid signature: %s",
    (signature) => {
      expect(verifyThreadsWebhookSignature("{}", signature)).toBe(false);
    },
  );

  it("requires the Threads app secret", () => {
    vi.stubEnv("THREADS_APP_SECRET", "");
    expect(() => verifyThreadsWebhookSignature("{}", "sha256=abc")).toThrow(
      "THREADS_APP_SECRET environment variable is required",
    );
  });
});

describe("parseThreadsReplyEvents", () => {
  const replyValue = {
    id: "reply_1",
    text: "Golfr",
    timestamp: "2026-09-13T12:00:00+0000",
    username: "fan",
    media_type: "TEXT_POST",
    permalink: "https://www.threads.com/@fan/post/reply",
    root_post: {
      id: "post_1",
      owner_id: "threads_user_1",
      username: "golfrai",
    },
    replied_to: { id: "post_1" },
  };

  it("parses a replies value from the documented Threads envelope", () => {
    expect(
      parseThreadsReplyEvents({
        app_id: "app_1",
        topic: "interaction",
        target_id: "post_1",
        time: 1_789_000_000,
        subscription_id: "subscription_1",
        values: [{ field: "replies", value: replyValue }],
      }),
    ).toEqual([
      {
        threadsUserId: "threads_user_1",
        rootPostId: "post_1",
        reply: {
          id: "reply_1",
          text: "Golfr",
          timestamp: "2026-09-13T12:00:00+0000",
          username: "fan",
          media_type: "TEXT_POST",
          permalink: "https://www.threads.com/@fan/post/reply",
          root_post: { id: "post_1" },
          replied_to: { id: "post_1" },
        },
      },
    ]);
  });

  it("accepts a single replies value object", () => {
    expect(
      parseThreadsReplyEvents({
        app_id: "app_1",
        topic: "interaction",
        target_id: "post_1",
        values: { field: "replies", value: replyValue },
      }),
    ).toHaveLength(1);
  });

  it("preserves ownership fields supplied for a reply", () => {
    const [event] = parseThreadsReplyEvents({
      values: {
        field: "replies",
        value: {
          ...replyValue,
          owner: { id: "reply_author_1" },
          is_reply: true,
          is_reply_owned_by_me: false,
        },
      },
    });

    expect(event.reply).toEqual(
      expect.objectContaining({
        owner: { id: "reply_author_1" },
        is_reply: true,
        is_reply_owned_by_me: false,
      }),
    );
  });

  it("parses every valid replies value and ignores unrelated fields", () => {
    const events = parseThreadsReplyEvents({
      values: [
        { field: "publish", value: { id: "post_2" } },
        { field: "replies", value: replyValue },
        {
          field: "replies",
          value: {
            ...replyValue,
            id: "reply_2",
            root_post: { id: "post_2", owner_id: "threads_user_2" },
          },
        },
      ],
    });

    expect(events.map((event) => event.reply.id)).toEqual([
      "reply_1",
      "reply_2",
    ]);
  });

  it.each([
    null,
    {},
    { values: { field: "replies", value: null } },
    { values: { field: "replies", value: { ...replyValue, id: "" } } },
    {
      values: {
        field: "replies",
        value: { ...replyValue, root_post: { owner_id: "threads_user_1" } },
      },
    },
    {
      values: {
        field: "replies",
        value: { ...replyValue, root_post: { id: "post_1" } },
      },
    },
  ])("ignores malformed payloads: %j", (payload) => {
    expect(parseThreadsReplyEvents(payload)).toEqual([]);
  });
});
