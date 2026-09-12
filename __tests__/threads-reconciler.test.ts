import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  campaignFindMany: vi.fn(),
  decryptToken: vi.fn(),
  getOwnedThreads: vi.fn(),
  getThreadsConversation: vi.fn(),
  processObservedThreadsReply: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsCampaign: { findMany: mocks.campaignFindMany },
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mocks.decryptToken,
}));

vi.mock("@/lib/threads/client", () => ({
  getOwnedThreads: mocks.getOwnedThreads,
  getThreadsConversation: mocks.getThreadsConversation,
}));

vi.mock("@/lib/threads/campaign-processor", () => ({
  processObservedThreadsReply: mocks.processObservedThreadsReply,
}));

import { reconcileThreadsReplies } from "../lib/polling/threads-reconciler";

const originalReplyCap = process.env.THREADS_POLL_MAX_PER_SWEEP;
const originalPostCap = process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP;

function campaign(
  accountId: string,
  options: { postId?: string | null; matchAnyPost?: boolean } = {}
) {
  return {
    threadsAccountId: accountId,
    postId: options.postId ?? null,
    matchAnyPost: options.matchAnyPost ?? false,
    threadsAccount: {
      id: accountId,
      accessToken: `encrypted-${accountId}`,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.THREADS_POLL_MAX_PER_SWEEP;
  delete process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP;
  mocks.decryptToken.mockImplementation((value: string) => `plain-${value}`);
  mocks.getOwnedThreads.mockResolvedValue([]);
  mocks.getThreadsConversation.mockResolvedValue([]);
  mocks.processObservedThreadsReply.mockResolvedValue("no_match");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalReplyCap === undefined) {
    delete process.env.THREADS_POLL_MAX_PER_SWEEP;
  } else {
    process.env.THREADS_POLL_MAX_PER_SWEEP = originalReplyCap;
  }
  if (originalPostCap === undefined) {
    delete process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP;
  } else {
    process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP = originalPostCap;
  }
});

describe("Threads polling reconciliation", () => {
  it("queries active campaigns with only polling fields", async () => {
    mocks.campaignFindMany.mockResolvedValue([]);

    await reconcileThreadsReplies();

    expect(mocks.campaignFindMany).toHaveBeenCalledWith({
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
  });

  it("discovers owned posts and fetches each account conversation once", async () => {
    const firstReply = { id: "reply-1" };
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { postId: "specific", matchAnyPost: false }),
      campaign("account-1", { matchAnyPost: true }),
    ]);
    mocks.getOwnedThreads.mockResolvedValue([
      { id: "specific" },
      { id: "discovered" },
      { id: "discovered" },
    ]);
    mocks.getThreadsConversation.mockImplementation(
      async (_token: string, postId: string) =>
        postId === "specific" ? [firstReply] : []
    );

    await expect(reconcileThreadsReplies()).resolves.toEqual({
      conversations: 2,
      observed: 1,
    });

    expect(mocks.decryptToken).toHaveBeenCalledOnce();
    expect(mocks.getOwnedThreads).toHaveBeenCalledOnce();
    expect(mocks.getOwnedThreads).toHaveBeenCalledWith(
      "plain-encrypted-account-1",
      100
    );
    expect(mocks.getThreadsConversation).toHaveBeenCalledTimes(2);
    expect(mocks.getThreadsConversation).toHaveBeenCalledWith(
      "plain-encrypted-account-1",
      "specific",
      30
    );
    expect(mocks.getThreadsConversation).toHaveBeenCalledWith(
      "plain-encrypted-account-1",
      "discovered",
      30
    );
    expect(mocks.processObservedThreadsReply).toHaveBeenCalledWith({
      threadsAccountId: "account-1",
      rootPostId: "specific",
      reply: firstReply,
      source: "POLLING",
    });
  });

  it("discovers a future owned post on the next sweep", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { matchAnyPost: true }),
    ]);
    mocks.getOwnedThreads
      .mockResolvedValueOnce([{ id: "existing" }])
      .mockResolvedValueOnce([{ id: "existing" }, { id: "future" }]);

    await reconcileThreadsReplies();
    await reconcileThreadsReplies();

    expect(mocks.getOwnedThreads).toHaveBeenCalledTimes(2);
    expect(mocks.getThreadsConversation.mock.calls.map((call) => call[1])).toEqual([
      "existing",
      "existing",
      "future",
    ]);
  });

  it("does not list owned posts for a specific-only account", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { postId: "specific" }),
      campaign("account-1", { postId: "specific" }),
      campaign("account-1", { postId: "other" }),
    ]);

    await reconcileThreadsReplies();

    expect(mocks.decryptToken).toHaveBeenCalledOnce();
    expect(mocks.getOwnedThreads).not.toHaveBeenCalled();
    expect(mocks.getThreadsConversation.mock.calls.map((call) => call[1])).toEqual([
      "specific",
      "other",
    ]);
  });

  it("lists owned posts once for multiple all-post campaigns on one account", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { matchAnyPost: true }),
      campaign("account-1", { matchAnyPost: true }),
    ]);

    await reconcileThreadsReplies();

    expect(mocks.decryptToken).toHaveBeenCalledOnce();
    expect(mocks.getOwnedThreads).toHaveBeenCalledOnce();
  });

  it("decrypts and discovers independently for multiple accounts", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { matchAnyPost: true }),
      campaign("account-2", { matchAnyPost: true }),
    ]);
    mocks.getOwnedThreads
      .mockResolvedValueOnce([{ id: "post-1" }])
      .mockResolvedValueOnce([{ id: "post-2" }]);

    await reconcileThreadsReplies();

    expect(mocks.decryptToken).toHaveBeenCalledTimes(2);
    expect(mocks.getOwnedThreads).toHaveBeenCalledTimes(2);
    expect(mocks.processObservedThreadsReply).not.toHaveBeenCalled();
    expect(mocks.getThreadsConversation).toHaveBeenNthCalledWith(
      1,
      "plain-encrypted-account-1",
      "post-1",
      30
    );
    expect(mocks.getThreadsConversation).toHaveBeenNthCalledWith(
      2,
      "plain-encrypted-account-2",
      "post-2",
      30
    );
  });

  it("continues with specific posts and other accounts when listing fails", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { matchAnyPost: true }),
      campaign("account-1", { postId: "specific" }),
      campaign("account-2", { postId: "other" }),
    ]);
    mocks.getOwnedThreads.mockRejectedValueOnce(new Error("listing failed"));

    await expect(reconcileThreadsReplies()).resolves.toEqual({
      conversations: 2,
      observed: 0,
    });

    expect(mocks.getThreadsConversation.mock.calls.map((call) => call[1])).toEqual([
      "specific",
      "other",
    ]);
    expect(console.error).toHaveBeenCalledWith(
      "[Threads Poller] account-1 owned posts: listing failed"
    );
  });

  it("isolates conversation and token decryption failures", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign("bad-token", { postId: "skipped" }),
      campaign("account-1", { postId: "broken" }),
      campaign("account-1", { postId: "working" }),
      campaign("account-2", { postId: "later" }),
    ]);
    mocks.decryptToken.mockImplementation((value: string) => {
      if (value === "encrypted-bad-token") throw new Error("decrypt failed");
      return `plain-${value}`;
    });
    mocks.getThreadsConversation.mockImplementation(
      async (_token: string, postId: string) => {
        if (postId === "broken") throw new Error("conversation failed");
        return [{ id: `reply-${postId}` }];
      }
    );

    await expect(reconcileThreadsReplies()).resolves.toEqual({
      conversations: 2,
      observed: 2,
    });

    expect(mocks.getThreadsConversation.mock.calls.map((call) => call[1])).toEqual([
      "broken",
      "working",
      "later",
    ]);
    expect(mocks.processObservedThreadsReply).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      "[Threads Poller] bad-token token: decrypt failed"
    );
    expect(console.error).toHaveBeenCalledWith(
      "[Threads Poller] account-1:broken: conversation failed"
    );
  });

  it("applies separate post discovery and reply caps", async () => {
    process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP = "7";
    process.env.THREADS_POLL_MAX_PER_SWEEP = "2";
    mocks.campaignFindMany.mockResolvedValue([
      campaign("account-1", { matchAnyPost: true }),
    ]);
    mocks.getOwnedThreads.mockResolvedValue([{ id: "post-1" }]);
    mocks.getThreadsConversation.mockResolvedValue([
      { id: "old" },
      { id: "newer" },
      { id: "newest" },
    ]);

    await expect(reconcileThreadsReplies()).resolves.toEqual({
      conversations: 1,
      observed: 2,
    });

    expect(mocks.getOwnedThreads).toHaveBeenCalledWith(
      "plain-encrypted-account-1",
      7
    );
    expect(mocks.getThreadsConversation).toHaveBeenCalledWith(
      "plain-encrypted-account-1",
      "post-1",
      2
    );
    expect(
      mocks.processObservedThreadsReply.mock.calls.map((call) => call[0].reply.id)
    ).toEqual(["newer", "newest"]);
  });

  it.each([
    ["not-a-number", 30, 100],
    ["NaN", 30, 100],
    ["Infinity", 30, 100],
    ["0", 30, 100],
    ["-4", 30, 100],
    ["0.5", 1, 1],
    ["2.9", 2, 2],
  ])(
    "normalizes a %s polling cap to reply=%i and posts=%i",
    async (value, expectedReplyCap, expectedPostCap) => {
      process.env.THREADS_POLL_MAX_PER_SWEEP = value;
      process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP = value;
      mocks.campaignFindMany.mockResolvedValue([
        campaign("account-1", { matchAnyPost: true }),
      ]);
      mocks.getOwnedThreads.mockResolvedValue([{ id: "post-1" }]);

      await reconcileThreadsReplies();

      expect(mocks.getOwnedThreads).toHaveBeenCalledWith(
        "plain-encrypted-account-1",
        expectedPostCap
      );
      expect(mocks.getThreadsConversation).toHaveBeenCalledWith(
        "plain-encrypted-account-1",
        "post-1",
        expectedReplyCap
      );
    }
  );
});
