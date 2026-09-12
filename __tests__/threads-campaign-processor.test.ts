import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  processedCreate: vi.fn(),
  campaignFindMany: vi.fn(),
  logCreate: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsAccount: { findUnique: mocks.accountFindUnique },
    processedThreadsReply: { create: mocks.processedCreate },
    threadsCampaign: { findMany: mocks.campaignFindMany },
    threadsReplyLog: { create: mocks.logCreate },
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
          { matchAnyPost: false, postId: "future_post" },
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
});
