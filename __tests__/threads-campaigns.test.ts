import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("prisma/schema.prisma", "utf8");

describe("Threads persistence schema", () => {
  it("keeps Threads accounts, campaigns, logs, and deduplication isolated", () => {
    for (const model of [
      "ThreadsAccount",
      "ThreadsCampaign",
      "ThreadsReplyLog",
      "ProcessedThreadsReply",
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
    expect(schema).toContain("enum ThreadsReplyStatus");
    expect(schema).toContain("@@unique([threadsCampaignId, replyId])");
    expect(schema).toContain("@@unique([threadsAccountId, replyId])");
  });
});
