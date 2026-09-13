import { describe, expect, it } from "vitest";
import { isOwnThreadsReply, normalizeThreadsReply } from "../lib/threads/replies";

describe("Threads reply normalization", () => {
  it("preserves root and parent identity for nested replies", () => {
    expect(normalizeThreadsReply({
      id: "reply_2",
      text: "GOLFR please",
      username: "visitor",
      owner: { id: "visitor_1" },
      root_post: { id: "post_1" },
      replied_to: { id: "reply_1" },
      is_reply_owned_by_me: false,
    })).toEqual({
      id: "reply_2",
      text: "GOLFR please",
      authorId: "visitor_1",
      authorName: "visitor",
      rootPostId: "post_1",
      parentReplyId: "reply_1",
      ownedByMe: false,
      timestamp: null,
    });
  });

  it("recognizes both Meta's ownership flag and the connected user id", () => {
    expect(isOwnThreadsReply({ id: "1", is_reply_owned_by_me: true }, "me")).toBe(true);
    expect(isOwnThreadsReply({ id: "2", owner: { id: "me" } }, "me")).toBe(true);
    expect(isOwnThreadsReply({ id: "3", owner: { id: "other" } }, "me")).toBe(false);
  });
});
