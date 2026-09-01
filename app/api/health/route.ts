import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
}

interface PublicWorkerHealth {
  healthy: boolean;
  heartbeat: {
    status: "running";
    worker: "dm";
    startedAt?: string;
    checkedAt: string;
  } | null;
  ageMs: number | null;
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  try {
    const pong = await getRedisConnection().ping();
    return { status: pong === "PONG" ? "ok" : "error" };
  } catch {
    return { status: "error" };
  }
}

async function checkQueue(): Promise<HealthCheck & { counts?: unknown }> {
  try {
    const counts = await getDMQueue().getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed"
    );
    return { status: "ok", counts };
  } catch {
    return { status: "error" };
  }
}

async function checkWorker(): Promise<PublicWorkerHealth> {
  try {
    const worker = await getWorkerHealth();
    return {
      healthy: worker.healthy,
      heartbeat: worker.heartbeat
        ? {
            status: worker.heartbeat.status,
            worker: worker.heartbeat.worker,
            startedAt: worker.heartbeat.startedAt,
            checkedAt: worker.heartbeat.checkedAt,
          }
        : null,
      ageMs: worker.ageMs,
    };
  } catch {
    return { healthy: false, heartbeat: null, ageMs: null };
  }
}

export async function GET() {
  const [database, redis, queue, worker] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    checkWorker(),
  ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database,
        redis,
        queue,
        worker,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
