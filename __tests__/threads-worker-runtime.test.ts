import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getThreadsPollIntervalMs } from "../lib/polling/interval";

describe("Threads worker runtime", () => {
  it.each([undefined, "", "0", "-1", "not-a-number"])(
    "uses the five-minute recovery interval for invalid value %s",
    (value) => {
      expect(getThreadsPollIntervalMs(value)).toBe(300_000);
    },
  );

  it("allows a positive configured recovery interval", () => {
    expect(getThreadsPollIntervalMs("600000")).toBe(600_000);
  });

  it("starts and closes the Threads webhook ingestion worker", () => {
    const source = readFileSync("worker/dm-worker.ts", "utf8");

    expect(source).toContain(
      'import { createThreadsWebhookWorker } from "@/lib/queue/threads-webhook-worker"',
    );
    expect(source).toContain(
      "const threadsWebhookWorker = createThreadsWebhookWorker()",
    );
    expect(source).toContain("threadsWebhookWorker.close()",
    );
    expect(source).toContain("getThreadsPollIntervalMs(");
  });
});
