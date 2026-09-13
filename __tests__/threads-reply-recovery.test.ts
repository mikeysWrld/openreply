import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  queueGetJob: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsReplyLog: { findMany: mocks.findMany },
  },
}));

vi.mock("@/lib/queue/client", () => ({
  getThreadsReplyQueue: () => ({
    getJob: mocks.queueGetJob,
    add: mocks.queueAdd,
  }),
}));

import { recoverPendingThreadsReplies } from "../lib/polling/threads-reply-recovery";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.findMany.mockResolvedValue([]);
  mocks.queueGetJob.mockResolvedValue(undefined);
  mocks.queueAdd.mockResolvedValue(undefined);
});

describe("Threads reply recovery", () => {
  it("re-enqueues an exhausted pending reply with its deterministic job id", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("failed"),
      remove,
    });
    mocks.findMany.mockResolvedValue([{
      id: "log_1",
      threadsAccountId: "account_1",
      threadsCampaignId: "campaign_1",
      replyId: "reply_1",
      attempts: 3,
      publishContainerId: "container_1",
      replyMessage: "Exact configured reply",
      threadsCampaign: { replyMessage: "Edited later" },
    }]);

    await expect(recoverPendingThreadsReplies()).resolves.toBe(1);

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "PENDING",
        threadsCampaign: { isActive: true },
      },
      take: 50,
    }));
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "publish-thread-reply",
      {
        threadsAccountId: "account_1",
        threadsCampaignId: "campaign_1",
        threadsReplyLogId: "log_1",
        replyId: "reply_1",
        replyMessage: "Exact configured reply",
      },
      { jobId: "threads_account_1_reply_1_campaign_1" }
    );
    expect(remove).toHaveBeenCalledOnce();
  });

  it("does not re-enqueue terminal failed replies", async () => {
    mocks.findMany.mockResolvedValue([]);

    await expect(recoverPendingThreadsReplies()).resolves.toBe(0);

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "PENDING",
        threadsCampaign: { isActive: true },
      },
    }));
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("honors a bounded configured recovery cap", async () => {
    vi.stubEnv("THREADS_REPLY_RECOVERY_MAX_PER_SWEEP", "7");

    await recoverPendingThreadsReplies();

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 7 }));
  });

  it.each(["active", "waiting", "delayed"])(
    "leaves an existing %s job deduplicated",
    async (state) => {
      mocks.findMany.mockResolvedValue([{
        id: "log_1",
        threadsAccountId: "account_1",
        threadsCampaignId: "campaign_1",
        replyId: "reply_1",
        threadsCampaign: { replyMessage: "Exact configured reply" },
      }]);
      mocks.queueGetJob.mockResolvedValue({
        getState: vi.fn().mockResolvedValue(state),
        remove: vi.fn(),
      });

      await expect(recoverPendingThreadsReplies()).resolves.toBe(0);

      expect(mocks.queueAdd).not.toHaveBeenCalled();
    }
  );
});
