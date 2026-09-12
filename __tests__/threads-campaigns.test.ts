import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const allPostsMigration = readFileSync(
  "prisma/migrations/20260913090000_add_threads_all_posts/migration.sql",
  "utf8",
);

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

  it("supports targeting all posts without changing existing campaigns", () => {
    const threadsCampaign = schema.match(
      /model ThreadsCampaign \{[\s\S]*?\n\}/,
    )?.[0];
    const normalizedThreadsCampaign = threadsCampaign?.replace(/\s+/g, " ");

    expect(normalizedThreadsCampaign).toContain(
      "matchAnyPost Boolean @default(false)",
    );
    expect(normalizedThreadsCampaign).toContain("postId String?");
    expect(normalizedThreadsCampaign).toContain("postUrl String?");
    expect(allPostsMigration).toContain(
      'ADD COLUMN "matchAnyPost" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(allPostsMigration).toContain(
      'ALTER COLUMN "postId" DROP NOT NULL',
    );
    expect(allPostsMigration).toContain(
      'ALTER COLUMN "postUrl" DROP NOT NULL',
    );
  });
});
