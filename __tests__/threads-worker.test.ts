import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  decrypt: vi.fn(() => "plain-token"),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsReplyLog: { findUnique: mocks.findUnique, update: mocks.update },
  },
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mocks.decrypt }));
vi.mock("@/lib/threads/client", () => ({
  publishThreadsReply: mocks.publish,
  ThreadsApiError: class ThreadsApiError extends Error {},
}));

import { processThreadsReplyJob } from "../lib/queue/threads-worker";

const job = {
  threadsAccountId: "account_1",
  threadsCampaignId: "campaign_1",
  threadsReplyLogId: "log_1",
  replyId: "reply_1",
  replyMessage: "感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/",
};

beforeEach(() => vi.clearAllMocks());

describe("Threads reply worker", () => {
  it("publishes a pending reply and marks the log sent", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "log_1",
      status: "PENDING",
      attempts: 0,
      threadsAccount: {
        threadsUserId: "42",
        accessToken: "encrypted",
      },
    });
    mocks.publish.mockResolvedValue("published_1");
    await processThreadsReplyJob(job);
    expect(mocks.publish).toHaveBeenCalledWith(
      "plain-token",
      "42",
      "reply_1",
      job.replyMessage
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({
        status: "SENT",
        publishedReplyId: "published_1",
        attempts: { increment: 1 },
      }),
    });
  });

  it("does not publish an already-sent log", async () => {
    mocks.findUnique.mockResolvedValue({ id: "log_1", status: "SENT" });
    await processThreadsReplyJob(job);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
