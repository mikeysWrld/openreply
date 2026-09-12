import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const allPostsMigration = readFileSync(
  "prisma/migrations/20260913090000_add_threads_all_posts/migration.sql",
  "utf8",
);
const publishLeaseMigration = readFileSync(
  "prisma/migrations/20260915090000_add_threads_publish_lease/migration.sql",
  "utf8",
);
const verificationMigrationPath =
  "prisma/migrations/20260916090000_add_threads_post_verification/migration.sql";
const verificationMigration = existsSync(verificationMigrationPath)
  ? readFileSync(verificationMigrationPath, "utf8")
  : "";

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

  it("adds nullable database-backed publish leases forward-only", () => {
    expect(schema).toContain("publishLeaseToken String?");
    expect(schema).toContain("publishLeaseExpiresAt DateTime?");
    expect(schema).toContain("replyMessage      String?");
    expect(publishLeaseMigration).toContain('ADD COLUMN "replyMessage" TEXT');
    expect(publishLeaseMigration).toContain('ADD COLUMN "publishLeaseToken" TEXT');
    expect(publishLeaseMigration).toContain(
      'ADD COLUMN "publishLeaseExpiresAt" TIMESTAMP(3)',
    );
  });

  it("adds verification provenance and pauses only legacy active specific campaigns", () => {
    const threadsCampaign = schema.match(
      /model ThreadsCampaign \{[\s\S]*?\n\}/,
    )?.[0];

    expect(threadsCampaign).toContain("postVerifiedAt");
    expect(threadsCampaign).toMatch(/postVerifiedAt\s+DateTime\?/);
    expect(verificationMigration).toContain(
      'ADD COLUMN "postVerifiedAt" TIMESTAMP(3)',
    );
    expect(verificationMigration).toMatch(
      /UPDATE\s+"ThreadsCampaign"[\s\S]*SET\s+"isActive"\s*=\s*false[\s\S]*WHERE\s+"isActive"\s*=\s*true[\s\S]*"matchAnyPost"\s*=\s*false/i,
    );
    expect(verificationMigration).not.toMatch(/SET\s+"postVerifiedAt"/i);
    expect(verificationMigration).toMatch(/provenance|unverified|legacy/i);
  });
});
