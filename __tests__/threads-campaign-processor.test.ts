import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  transaction: vi.fn(),
  processedCreate: vi.fn(),
  campaignFindMany: vi.fn(),
  logCreate: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsAccount: { findUnique: mocks.accountFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/queue/client", () => ({
  getThreadsReplyQueue: () => ({ add: mocks.queueAdd }),
}));

import { Prisma } from "../app/generated/prisma/client";
import { processObservedThreadsReply } from "../lib/threads/campaign-processor";

const input = {
  threadsAccountId: "account_1",
  rootPostId: "future_post",
  reply: {
    id: "reply_1",
    text: "Please send the LINK",
    username: "visitor",
    owner: { id: "visitor_1" },
  },
  source: "WEBHOOK" as const,
};

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "campaign_1",
    workspaceId: "workspace_1",
    threadsAccountId: "account_1",
    name: "Links",
    postId: null,
    postUrl: null,
    matchAnyPost: true,
    keywords: ["LINK"],
    wholeWordMatch: true,
    replyMessage: "Here is the link",
    isActive: true,
    postVerifiedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountFindUnique.mockResolvedValue({
    threadsUserId: "owner_1",
    workspaceId: "workspace_1",
  });
  mocks.processedCreate.mockResolvedValue({ id: "processed_1" });
  mocks.campaignFindMany.mockResolvedValue([]);
  mocks.logCreate.mockResolvedValue({ id: "log_1" });
  mocks.queueAdd.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation((callback) => callback({
    processedThreadsReply: { create: mocks.processedCreate },
    threadsCampaign: { findMany: mocks.campaignFindMany },
    threadsReplyLog: { create: mocks.logCreate },
  }));
});

describe("Threads campaign reply selection", () => {
  it("matches an all-post campaign on an arbitrary future root post", async () => {
    mocks.campaignFindMany.mockResolvedValue([campaign()]);

    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.logCreate).toHaveBeenCalledOnce();
    expect(mocks.logCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_1",
        threadsCampaignId: "campaign_1",
        threadsAccountId: "account_1",
        replyId: "reply_1",
        replyAuthorId: "visitor_1",
        replyAuthorName: "visitor",
        replyText: "Please send the LINK",
        replyMessage: "Here is the link",
        matchedKeyword: "LINK",
      },
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "publish-thread-reply",
      {
        threadsAccountId: "account_1",
        threadsCampaignId: "campaign_1",
        threadsReplyLogId: "log_1",
        replyId: "reply_1",
        replyMessage: "Here is the link",
      },
      { jobId: "threads_account_1_reply_1_campaign_1" }
    );
  });

  it("selects a matching specific campaign before a matching all-post campaign", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign({
        id: "specific",
        matchAnyPost: false,
        postId: "future_post",
        replyMessage: "Specific reply",
      }),
      campaign({ id: "all-post", replyMessage: "General reply" }),
    ]);

    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.logCreate).toHaveBeenCalledOnce();
    expect(mocks.logCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadsCampaignId: "specific" }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "publish-thread-reply",
      expect.objectContaining({ threadsCampaignId: "specific" }),
      { jobId: "threads_account_1_reply_1_specific" }
    );
  });

  it("falls through to an all-post campaign when a specific campaign does not match", async () => {
    mocks.campaignFindMany.mockResolvedValue([
      campaign({
        id: "specific",
        matchAnyPost: false,
        postId: "future_post",
        keywords: ["DISCOUNT"],
      }),
      campaign({ id: "all-post" }),
    ]);

    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.logCreate).toHaveBeenCalledOnce();
    expect(mocks.logCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadsCampaignId: "all-post" }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("queries campaigns with deterministic specific-first and oldest-first ordering", async () => {
    await expect(processObservedThreadsReply(input)).resolves.toBe("no_match");

    expect(mocks.campaignFindMany).toHaveBeenCalledWith({
      where: {
        threadsAccountId: "account_1",
        isActive: true,
        OR: [
          { matchAnyPost: true },
          {
            matchAnyPost: false,
            postId: "future_post",
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
  });

  it("does not record or queue a reply owned by the connected account", async () => {
    const result = await processObservedThreadsReply({
      ...input,
      reply: { ...input.reply, owner: { id: "owner_1" } },
    });

    expect(result).toBe("self");
    expect(mocks.processedCreate).not.toHaveBeenCalled();
    expect(mocks.campaignFindMany).not.toHaveBeenCalled();
    expect(mocks.logCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("returns seen and queues nothing for a duplicate processed reply", async () => {
    mocks.processedCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    await expect(processObservedThreadsReply(input)).resolves.toBe("seen");

    expect(mocks.campaignFindMany).not.toHaveBeenCalled();
    expect(mocks.logCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("retries the reply after a campaign lookup failure rolls back its marker", async () => {
    mocks.campaignFindMany
      .mockRejectedValueOnce(new Error("campaign lookup failed"))
      .mockResolvedValueOnce([campaign()]);

    await expect(processObservedThreadsReply(input)).rejects.toThrow(
      "campaign lookup failed",
    );
    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.processedCreate).toHaveBeenCalledTimes(2);
    expect(mocks.logCreate).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("retries the reply after a reply-log P2002 rolls back its marker", async () => {
    mocks.campaignFindMany.mockResolvedValue([campaign()]);
    mocks.logCreate
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("reply log conflict", {
          code: "P2002",
          clientVersion: "test",
        }),
      )
      .mockResolvedValueOnce({ id: "log_1" });

    await expect(processObservedThreadsReply(input)).rejects.toThrow();
    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.processedCreate).toHaveBeenCalledTimes(2);
    expect(mocks.logCreate).toHaveBeenCalledTimes(2);
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("commits the processed marker when no campaign matches", async () => {
    await expect(processObservedThreadsReply(input)).resolves.toBe("no_match");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.processedCreate).toHaveBeenCalledOnce();
    expect(mocks.logCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });
});
