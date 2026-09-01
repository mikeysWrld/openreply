import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockRedis, mockQueue, mockGetWorkerHealth } = vi.hoisted(
  () => ({
    mockPrisma: { $queryRaw: vi.fn() },
    mockRedis: { ping: vi.fn() },
    mockQueue: { getJobCounts: vi.fn() },
    mockGetWorkerHealth: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => mockRedis,
  getDMQueue: () => mockQueue,
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth: mockGetWorkerHealth,
}));

import { GET } from "../app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mockRedis.ping.mockResolvedValue("PONG");
  mockQueue.getJobCounts.mockResolvedValue({
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
  });
  mockGetWorkerHealth.mockResolvedValue({
    healthy: true,
    heartbeat: {
      status: "running",
      worker: "dm",
      pid: 123,
      hostname: "worker.internal",
      startedAt: "2026-09-01T00:00:00.000Z",
      checkedAt: "2026-09-01T00:01:00.000Z",
    },
    ageMs: 1_000,
  });
});

describe("health route", () => {
  it("returns component state without internal hostnames on success", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.worker.healthy).toBe(true);
    expect(body.checks.worker.heartbeat.hostname).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("worker.internal");
  });

  it("sanitizes dependency failures and remains degraded without a heartbeat", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres.internal:5432/private")
    );
    mockRedis.ping.mockRejectedValue(
      new Error("redis://default:secret@redis.internal:6379")
    );
    mockQueue.getJobCounts.mockRejectedValue(
      new Error("queue failed at https://queue.internal/jobs")
    );
    mockGetWorkerHealth.mockRejectedValue(
      new Error("worker.internal heartbeat read failed")
    );

    const response = await GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toEqual({ status: "error" });
    expect(body.checks.redis).toEqual({ status: "error" });
    expect(body.checks.queue).toEqual({ status: "error" });
    expect(body.checks.worker).toEqual({
      healthy: false,
      heartbeat: null,
      ageMs: null,
    });
    expect(serialized).not.toContain("internal");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("ECONNREFUSED");
  });

  it("returns 503 when the worker heartbeat is missing", async () => {
    mockGetWorkerHealth.mockResolvedValue({
      healthy: false,
      heartbeat: null,
      ageMs: null,
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.healthy).toBe(false);
  });
});
