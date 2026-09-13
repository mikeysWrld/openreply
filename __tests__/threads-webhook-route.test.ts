import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  add: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    webhookEvent: {
      create: mocks.create,
      update: mocks.update,
    },
  },
}));

vi.mock("@/lib/queue/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue/client")>();
  return {
    ...actual,
    getThreadsWebhookQueue: () => ({ add: mocks.add }),
  };
});

import { GET, POST } from "../app/api/threads/webhook/route";
import { THREADS_WEBHOOK_JOB_NAME } from "../lib/queue/client";

function signedRequest(payload: string) {
  const signature = `sha256=${createHmac("sha256", "threads-secret")
    .update(payload)
    .digest("hex")}`;
  return new NextRequest("https://example.com/api/threads/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": signature },
    body: payload,
  });
}

const replyPayload = {
  app_id: "app_1",
  topic: "interaction",
  target_id: "post_1",
  subscription_id: "subscription_1",
  time: 1_789_000_000,
  values: {
    field: "replies",
    value: {
      id: "reply_1",
      text: "Golfr",
      timestamp: "2026-09-13T12:00:00+0000",
      username: "fan",
      root_post: { id: "post_1", owner_id: "threads_user_1" },
      replied_to: { id: "post_1" },
    },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("THREADS_APP_SECRET", "threads-secret");
  vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "verify-me");
  mocks.create.mockResolvedValue({ id: "webhook_1" });
  mocks.update.mockResolvedValue({});
  mocks.add.mockResolvedValue({});
});

describe("Threads webhook route", () => {
  it("echoes Meta's challenge for the configured verify token", async () => {
    const response = await GET(
      new NextRequest(
        "https://example.com/api/threads/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge_123",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("challenge_123");
  });

  it("rejects an incorrect verification token", async () => {
    const response = await GET(
      new NextRequest(
        "https://example.com/api/threads/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge_123",
      ),
    );

    expect(response.status).toBe(403);
  });

  it("rejects an invalid signature before storing the delivery", async () => {
    const response = await POST(
      new NextRequest("https://example.com/api/threads/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=wrong" },
        body: JSON.stringify(replyPayload),
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON without storing it", async () => {
    const response = await POST(signedRequest("not-json"));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("records and completes a signed delivery with no reply events", async () => {
    const payload = JSON.stringify({
      ...replyPayload,
      values: { field: "publish", value: { id: "post_1" } },
    });
    const response = await POST(signedRequest(payload));

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        object: "threads",
        payload: JSON.parse(payload),
        status: "PENDING",
      },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "webhook_1" },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
      },
    });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("stores one delivery and enqueues its reply events", async () => {
    const payload = JSON.stringify(replyPayload);
    const response = await POST(signedRequest(payload));

    expect(response.status).toBe(200);
    expect(mocks.add).toHaveBeenCalledWith(
      THREADS_WEBHOOK_JOB_NAME,
      {
        webhookEventId: "webhook_1",
        events: [
          {
            threadsUserId: "threads_user_1",
            rootPostId: "post_1",
            reply: expect.objectContaining({ id: "reply_1", text: "Golfr" }),
          },
        ],
      },
      { jobId: "threads_webhook_webhook_1" },
    );
  });

  it("marks a delivery failed and returns 500 when queueing fails", async () => {
    mocks.add.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(signedRequest(JSON.stringify(replyPayload)));

    expect(response.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "webhook_1" },
      data: {
        status: "FAILED",
        errorMessage: "redis unavailable",
        processedAt: expect.any(Date),
      },
    });
  });
});
