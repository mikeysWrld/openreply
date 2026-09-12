import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  createContainer: vi.fn(),
  getContainerStatus: vi.fn(),
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
  createThreadsReplyContainer: mocks.createContainer,
  getThreadsContainerStatus: mocks.getContainerStatus,
  publishThreadsReplyContainer: mocks.publish,
  ThreadsApiError: class ThreadsApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: number | null,
      readonly retryable: boolean
    ) {
      super(message);
    }
  },
}));

import { processThreadsReplyJob } from "../lib/queue/threads-worker";
import { ThreadsApiError } from "../lib/threads/client";

const job = {
  threadsAccountId: "account_1",
  threadsCampaignId: "campaign_1",
  threadsReplyLogId: "log_1",
  replyId: "reply_1",
  replyMessage: "感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/",
};

beforeEach(() => vi.clearAllMocks());

describe("Threads reply worker", () => {
  function log(publishContainerId: string | null = null) {
    return {
      id: "log_1",
      status: "PENDING",
      attempts: 0,
      publishContainerId,
      publishedReplyId: null,
      threadsAccount: {
        threadsUserId: "42",
        accessToken: "encrypted",
      },
    };
  }

  it("creates and persists a container before publishing it", async () => {
    mocks.findUnique.mockResolvedValue(log());
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus.mockResolvedValue({ id: "container_1", status: "FINISHED" });
    mocks.publish.mockResolvedValue("published_1");
    await processThreadsReplyJob(job);
    expect(mocks.createContainer).toHaveBeenCalledWith(
      "plain-token",
      "42",
      "reply_1",
      job.replyMessage
    );
    expect(mocks.update).toHaveBeenNthCalledWith(1, {
      where: { id: "log_1" },
      data: { publishContainerId: "container_1" },
    });
    expect(mocks.getContainerStatus).toHaveBeenCalledWith("plain-token", "container_1");
    expect(mocks.publish).toHaveBeenCalledWith(
      "plain-token",
      "42",
      "container_1"
    );
    expect(mocks.update).toHaveBeenNthCalledWith(2, {
      where: { id: "log_1" },
      data: expect.objectContaining({
        status: "SENT",
        publishedReplyId: "published_1",
        attempts: { increment: 1 },
      }),
    });
  });

  it("marks a stored published container sent without publishing again", async () => {
    mocks.findUnique.mockResolvedValue({
      ...log("container_1"),
      publishedReplyId: null,
    });
    mocks.getContainerStatus.mockResolvedValue({ id: "container_1", status: "PUBLISHED" });

    await processThreadsReplyJob(job);

    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({
        status: "SENT",
        publishedReplyId: null,
        attempts: { increment: 1 },
      }),
    });
  });

  it("reuses the persisted container after a later failure", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(log())
      .mockResolvedValueOnce(log("container_1"));
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus
      .mockResolvedValueOnce({ id: "container_1", status: "IN_PROGRESS" })
      .mockResolvedValueOnce({ id: "container_1", status: "FINISHED" });
    mocks.publish.mockResolvedValue("published_1");

    await expect(processThreadsReplyJob(job)).rejects.toThrow(/in progress/i);
    await processThreadsReplyJob(job);

    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith("plain-token", "42", "container_1");
  });

  it("status-checks the same container when the publish response is lost", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(log())
      .mockResolvedValueOnce(log("container_1"));
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus
      .mockResolvedValueOnce({ id: "container_1", status: "FINISHED" })
      .mockResolvedValueOnce({ id: "container_1", status: "PUBLISHED" });
    mocks.publish.mockRejectedValueOnce(new Error("connection closed"));

    await expect(processThreadsReplyJob(job)).rejects.toThrow("connection closed");
    await processThreadsReplyJob(job);

    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.getContainerStatus).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({
        status: "SENT",
        publishedReplyId: null,
      }),
    });
  });

  it("does not publish an in-progress container", async () => {
    mocks.findUnique.mockResolvedValue(log("container_1"));
    mocks.getContainerStatus.mockResolvedValue({ id: "container_1", status: "IN_PROGRESS" });

    await expect(processThreadsReplyJob(job)).rejects.toThrow(/in progress/i);

    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each(["ERROR", "EXPIRED"] as const)(
    "stops retries for a %s container without creating another",
    async (status) => {
      mocks.findUnique.mockResolvedValue(log("container_1"));
      mocks.getContainerStatus.mockResolvedValue({
        id: "container_1",
        status,
        error_message: status === "ERROR" ? "Meta rejected it" : undefined,
      });

      await expect(processThreadsReplyJob(job)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(mocks.createContainer).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    }
  );

  it("stops retries for a permanent Threads API failure", async () => {
    mocks.findUnique.mockResolvedValue(log("container_1"));
    mocks.getContainerStatus.mockRejectedValue(
      new ThreadsApiError("permission denied", 403, null, false)
    );

    await expect(processThreadsReplyJob(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "permission denied",
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
