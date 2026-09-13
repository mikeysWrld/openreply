import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessThreadsWebhookJob } from "../lib/queue/client";

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  webhookUpdate: vi.fn(),
  processObserved: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    threadsAccount: { findUnique: mocks.accountFindUnique },
    webhookEvent: { update: mocks.webhookUpdate },
  },
}));

vi.mock("@/lib/threads/campaign-processor", () => ({
  processObservedThreadsReply: mocks.processObserved,
}));

import { processThreadsWebhookJob } from "../lib/queue/threads-webhook-worker";

const reply = {
  id: "reply_1",
  text: "Golfr",
  timestamp: "2026-09-13T12:00:00+0000",
  username: "fan",
  root_post: { id: "post_1" },
  replied_to: { id: "post_1" },
};

const job: ProcessThreadsWebhookJob = {
  webhookEventId: "webhook_1",
  events: [
    {
      threadsUserId: "threads_user_1",
      rootPostId: "post_1",
      reply,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accountFindUnique.mockResolvedValue({ id: "account_1" });
  mocks.processObserved.mockResolvedValue("queued");
  mocks.webhookUpdate.mockResolvedValue({});
});

describe("Threads webhook ingestion worker", () => {
  it("routes a reply through the shared atomic campaign processor", async () => {
    await processThreadsWebhookJob(job);

    expect(mocks.accountFindUnique).toHaveBeenCalledWith({
      where: { threadsUserId: "threads_user_1" },
      select: { id: true },
    });
    expect(mocks.processObserved).toHaveBeenCalledWith({
      threadsAccountId: "account_1",
      rootPostId: "post_1",
      reply,
      source: "WEBHOOK",
    });
    expect(mocks.webhookUpdate).toHaveBeenLastCalledWith({
      where: { id: "webhook_1" },
      data: {
        status: "PROCESSED",
        errorMessage: null,
        processedAt: expect.any(Date),
      },
    });
  });

  it("resolves each connected Threads user only once per delivery", async () => {
    await processThreadsWebhookJob({
      ...job,
      events: [
        ...job.events,
        {
          ...job.events[0],
          rootPostId: "post_2",
          reply: { ...reply, id: "reply_2", root_post: { id: "post_2" } },
        },
      ],
    });

    expect(mocks.accountFindUnique).toHaveBeenCalledOnce();
    expect(mocks.processObserved).toHaveBeenCalledTimes(2);
  });

  it("acknowledges replies for an account that is not connected", async () => {
    mocks.accountFindUnique.mockResolvedValue(null);

    await processThreadsWebhookJob(job);

    expect(mocks.processObserved).not.toHaveBeenCalled();
    expect(mocks.webhookUpdate).toHaveBeenLastCalledWith({
      where: { id: "webhook_1" },
      data: {
        status: "PROCESSED",
        errorMessage: null,
        processedAt: expect.any(Date),
      },
    });
  });

  it("marks the delivery failed and rethrows processor failures", async () => {
    const secret = "threads-access-token";
    mocks.processObserved.mockRejectedValue(
      new Error(`${"x".repeat(550)}${secret}`),
    );

    await expect(processThreadsWebhookJob(job)).rejects.toThrow();

    const failure = mocks.webhookUpdate.mock.calls.at(-1)?.[0];
    expect(failure).toEqual({
      where: { id: "webhook_1" },
      data: {
        status: "FAILED",
        errorMessage: expect.any(String),
        processedAt: expect.any(Date),
      },
    });
    expect(failure.data.errorMessage).toHaveLength(500);
    expect(failure.data.errorMessage).not.toContain(secret);
  });
});
