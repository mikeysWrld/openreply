import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  createContainer: vi.fn(),
  getContainerStatus: vi.fn(),
  publish: vi.fn(),
  decrypt: vi.fn(() => "plain-token"),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsReplyLog: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
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
      this.name = "ThreadsApiError";
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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.decrypt.mockReturnValue("plain-token");
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("Threads reply worker", () => {
  function log(publishContainerId: string | null = null) {
    return {
      id: "log_1",
      status: "PENDING",
      attempts: 0,
      publishContainerId,
      publishedReplyId: null,
      publishLeaseToken: null,
      publishLeaseExpiresAt: null,
      threadsAccount: {
        threadsUserId: "42",
        accessToken: "encrypted",
      },
      threadsCampaign: {
        isActive: true,
      },
    };
  }

  it("does not publish a queued reply after its campaign is paused", async () => {
    mocks.findUnique.mockResolvedValue({
      ...log(),
      threadsCampaign: { isActive: false },
    });

    await processThreadsReplyJob(job);

    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.getContainerStatus).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

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
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
      data: { publishContainerId: "container_1" },
    });
    expect(mocks.getContainerStatus).toHaveBeenCalledWith("plain-token", "container_1");
    expect(mocks.publish).toHaveBeenCalledWith(
      "plain-token",
      "42",
      "container_1"
    );
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
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
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
      data: expect.objectContaining({
        status: "SENT",
        publishedReplyId: null,
        attempts: { increment: 1 },
      }),
    });
  });

  it("reuses the persisted container after a later failure", async () => {
    mocks.findUnique.mockResolvedValue(log());
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus
      .mockResolvedValueOnce({ id: "container_1", status: "IN_PROGRESS" })
      .mockResolvedValueOnce({ id: "container_1", status: "FINISHED" });
    mocks.publish.mockResolvedValue("published_1");

    await expect(processThreadsReplyJob(job)).rejects.toThrow(/in progress/i);
    mocks.findUnique.mockResolvedValue(log("container_1"));
    await processThreadsReplyJob(job);

    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith("plain-token", "42", "container_1");
  });

  it("status-checks the same container when the publish response is lost", async () => {
    mocks.findUnique.mockResolvedValue(log());
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus
      .mockResolvedValueOnce({ id: "container_1", status: "FINISHED" })
      .mockResolvedValueOnce({ id: "container_1", status: "PUBLISHED" });
    mocks.publish.mockRejectedValueOnce(new Error("connection closed"));

    await expect(processThreadsReplyJob(job)).rejects.toThrow("connection closed");
    mocks.findUnique.mockResolvedValue(log("container_1"));
    await processThreadsReplyJob(job);

    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.getContainerStatus).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
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
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
      data: expect.objectContaining({
        status: "PENDING",
        attempts: { increment: 1 },
        publishLeaseToken: null,
        publishLeaseExpiresAt: null,
      }),
    });
  });

  it.each([0, 429, 503])(
    "keeps retryable API status %i pending",
    async (status) => {
      mocks.findUnique.mockResolvedValue(log("container_1"));
      mocks.getContainerStatus.mockRejectedValue(
        new ThreadsApiError("temporary Meta failure", status, null, true)
      );

      await expect(processThreadsReplyJob(job)).rejects.toBeInstanceOf(ThreadsApiError);

      expect(mocks.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ id: "log_1" }),
        data: expect.objectContaining({
          status: "PENDING",
          errorMessage: "temporary Meta failure",
          attempts: { increment: 1 },
        }),
      });
    }
  );

  it("does not publish a container with an invalid status", async () => {
    mocks.findUnique.mockResolvedValue(log("container_1"));
    mocks.getContainerStatus.mockResolvedValue({
      id: "container_1",
      status: "UNKNOWN",
    });

    await expect(processThreadsReplyJob(job)).rejects.toMatchObject({
      name: "ThreadsApiError",
      retryable: true,
    });

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
      data: expect.objectContaining({ status: "PENDING" }),
    });
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
      expect(mocks.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ id: "log_1" }),
        data: expect.objectContaining({ status: "FAILED" }),
      });
    }
  );

  it("stops retries for a permanent Threads API failure", async () => {
    mocks.findUnique.mockResolvedValue(log("container_1"));
    mocks.getContainerStatus.mockRejectedValue(
      new ThreadsApiError("permission denied", 403, null, false)
    );

    await expect(processThreadsReplyJob(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "log_1" }),
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

  it("does not retry a terminal failed log", async () => {
    mocks.findUnique.mockResolvedValue({ ...log("container_1"), status: "FAILED" });

    await processThreadsReplyJob(job);

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.getContainerStatus).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("allows only one of two contenders to create and publish", async () => {
    mocks.findUnique.mockResolvedValue(log());
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus.mockResolvedValue({ id: "container_1", status: "FINISHED" });
    mocks.publish.mockResolvedValue("published_1");

    await Promise.all([processThreadsReplyJob(job), processThreadsReplyJob(job)]);

    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("does not create or publish when another worker owns the lease", async () => {
    mocks.findUnique.mockResolvedValue(log());
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await processThreadsReplyJob(job);

    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.findUnique).toHaveBeenCalledOnce();
  });

  it("reclaims an expired publish lease", async () => {
    mocks.findUnique.mockResolvedValue({
      ...log(),
      publishLeaseToken: "stale-owner",
      publishLeaseExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    mocks.createContainer.mockResolvedValue("container_1");
    mocks.getContainerStatus.mockResolvedValue({ id: "container_1", status: "FINISHED" });
    mocks.publish.mockResolvedValue("published_1");

    await processThreadsReplyJob(job);

    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "log_1",
        OR: expect.arrayContaining([
          { publishLeaseToken: null },
          { publishLeaseExpiresAt: { lt: expect.any(Date) } },
        ]),
      }),
    }));
    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("stops after creation if it loses the lease before persisting the container", async () => {
    mocks.findUnique.mockResolvedValue(log());
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mocks.createContainer.mockResolvedValue("container_1");

    await processThreadsReplyJob(job);

    expect(mocks.createContainer).toHaveBeenCalledOnce();
    expect(mocks.getContainerStatus).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("renews and verifies lease ownership before publishing", async () => {
    mocks.findUnique.mockResolvedValue(log("container_1"));
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mocks.getContainerStatus.mockResolvedValue({ id: "container_1", status: "FINISHED" });

    await processThreadsReplyJob(job);

    expect(mocks.getContainerStatus).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        id: "log_1",
        publishLeaseToken: expect.any(String),
      }),
      data: { publishLeaseExpiresAt: expect.any(Date) },
    });
  });
});
