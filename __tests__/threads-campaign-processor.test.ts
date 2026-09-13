import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  transaction: vi.fn(),
  processedCreateMany: vi.fn(),
  campaignFindMany: vi.fn(),
  logCreate: vi.fn(),
  pendingFindMany: vi.fn(),
  queueGetJob: vi.fn(),
  queueAdd: vi.fn(),
}));

const transactionState = vi.hoisted(() => ({
  markers: new Map<string, {
    threadsAccountId: string;
    replyId: string;
    source: string;
  }>(),
  logs: [] as Array<Record<string, unknown> & { id: string; status: string }>,
  tail: Promise.resolve(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsAccount: { findUnique: mocks.accountFindUnique },
    $transaction: mocks.transaction,
    threadsReplyLog: { findMany: mocks.pendingFindMany },
  },
}));

vi.mock("@/lib/queue/client", () => ({
  getThreadsReplyQueue: () => ({
    add: mocks.queueAdd,
    getJob: mocks.queueGetJob,
  }),
}));

import { recoverPendingThreadsReplies } from "../lib/polling/threads-reply-recovery";
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
  transactionState.markers.clear();
  transactionState.logs.length = 0;
  transactionState.tail = Promise.resolve();
  mocks.accountFindUnique.mockResolvedValue({
    threadsUserId: "owner_1",
    workspaceId: "workspace_1",
  });
  mocks.processedCreateMany.mockResolvedValue(undefined);
  mocks.campaignFindMany.mockResolvedValue([]);
  mocks.logCreate.mockResolvedValue(undefined);
  mocks.pendingFindMany.mockImplementation(() =>
    transactionState.logs
      .filter((log) => log.status === "PENDING")
      .map((log) => ({
        ...log,
        threadsCampaign: { replyMessage: log.replyMessage },
      })),
  );
  mocks.queueGetJob.mockResolvedValue(undefined);
  mocks.queueAdd.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async (callback) => {
    const previousTransaction = transactionState.tail;
    let releaseTransaction = () => {};
    transactionState.tail = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previousTransaction;

    const stagedMarkers = new Map(transactionState.markers);
    const stagedLogs = [...transactionState.logs];
    try {
      const result = await callback({
        processedThreadsReply: {
          createMany: async (args: {
            data: {
              threadsAccountId: string;
              replyId: string;
              source: string;
            };
            skipDuplicates: boolean;
          }) => {
            await mocks.processedCreateMany(args);
            const key = `${args.data.threadsAccountId}:${args.data.replyId}`;
            if (stagedMarkers.has(key)) return { count: 0 };
            stagedMarkers.set(key, args.data);
            return { count: 1 };
          },
        },
        threadsCampaign: { findMany: mocks.campaignFindMany },
        threadsReplyLog: {
          create: async (args: { data: Record<string, unknown> }) => {
            const injected = await mocks.logCreate(args);
            const log = {
              id: injected?.id ?? `log_${stagedLogs.length + 1}`,
              ...args.data,
              status: "PENDING",
            };
            stagedLogs.push(log);
            return log;
          },
        },
      });
      transactionState.markers.clear();
      for (const [key, marker] of stagedMarkers) {
        transactionState.markers.set(key, marker);
      }
      transactionState.logs.splice(0, transactionState.logs.length, ...stagedLogs);
      return result;
    } finally {
      releaseTransaction();
    }
  });
});

describe("Threads campaign reply selection", () => {
  it("matches an all-post campaign on an arbitrary future root post", async () => {
    mocks.campaignFindMany.mockResolvedValue([campaign()]);

    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.processedCreateMany).toHaveBeenCalledWith({
      data: {
        threadsAccountId: "account_1",
        replyId: "reply_1",
        source: "WEBHOOK",
      },
      skipDuplicates: true,
    });
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
    expect(mocks.processedCreateMany).not.toHaveBeenCalled();
    expect(mocks.campaignFindMany).not.toHaveBeenCalled();
    expect(mocks.logCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("lets only one concurrent observation commit and queue", async () => {
    mocks.campaignFindMany.mockResolvedValue([campaign()]);

    const results = await Promise.all([
      processObservedThreadsReply(input),
      processObservedThreadsReply(input),
    ]);

    expect(results.sort()).toEqual(["queued", "seen"]);
    expect(transactionState.markers).toHaveLength(1);
    expect(transactionState.logs).toHaveLength(1);
    expect(mocks.campaignFindMany).toHaveBeenCalledOnce();
    expect(mocks.logCreate).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("retries the reply after a campaign lookup failure rolls back its marker", async () => {
    mocks.campaignFindMany
      .mockRejectedValueOnce(new Error("campaign lookup failed"))
      .mockResolvedValueOnce([campaign()]);

    await expect(processObservedThreadsReply(input)).rejects.toThrow(
      "campaign lookup failed",
    );
    expect(transactionState.markers).toHaveLength(0);
    expect(transactionState.logs).toHaveLength(0);
    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.processedCreateMany).toHaveBeenCalledTimes(2);
    expect(transactionState.markers).toHaveLength(1);
    expect(transactionState.logs).toHaveLength(1);
    expect(mocks.logCreate).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("retries the reply after a reply-log failure rolls back its marker and log", async () => {
    mocks.campaignFindMany.mockResolvedValue([campaign()]);
    mocks.logCreate
      .mockRejectedValueOnce(new Error("reply log failed"))
      .mockResolvedValueOnce(undefined);

    await expect(processObservedThreadsReply(input)).rejects.toThrow(
      "reply log failed",
    );
    expect(transactionState.markers).toHaveLength(0);
    expect(transactionState.logs).toHaveLength(0);
    await expect(processObservedThreadsReply(input)).resolves.toBe("queued");

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.processedCreateMany).toHaveBeenCalledTimes(2);
    expect(transactionState.markers).toHaveLength(1);
    expect(transactionState.logs).toHaveLength(1);
    expect(mocks.logCreate).toHaveBeenCalledTimes(2);
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it("commits the processed marker when no campaign matches", async () => {
    await expect(processObservedThreadsReply(input)).resolves.toBe("no_match");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.processedCreateMany).toHaveBeenCalledOnce();
    expect(transactionState.markers).toHaveLength(1);
    expect(transactionState.logs).toHaveLength(0);
    expect(mocks.logCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("recovers a committed pending log after the first queue add fails", async () => {
    mocks.campaignFindMany.mockResolvedValue([campaign()]);
    mocks.queueAdd
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(processObservedThreadsReply(input)).rejects.toThrow(
      "queue unavailable",
    );
    expect(transactionState.markers).toHaveLength(1);
    expect(transactionState.logs).toHaveLength(1);
    expect(transactionState.logs[0]).toEqual(
      expect.objectContaining({ id: "log_1", status: "PENDING" }),
    );

    await expect(recoverPendingThreadsReplies()).resolves.toBe(1);

    expect(mocks.queueAdd).toHaveBeenLastCalledWith(
      "publish-thread-reply",
      {
        threadsAccountId: "account_1",
        threadsCampaignId: "campaign_1",
        threadsReplyLogId: "log_1",
        replyId: "reply_1",
        replyMessage: "Here is the link",
      },
      { jobId: "threads_account_1_reply_1_campaign_1" },
    );
  });
});
