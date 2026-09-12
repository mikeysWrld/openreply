-- CreateEnum
CREATE TYPE "ThreadsReplyStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "ThreadsAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadsUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ThreadsAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThreadsCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadsAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "postUrl" TEXT NOT NULL,
    "keywords" TEXT[],
    "wholeWordMatch" BOOLEAN NOT NULL DEFAULT true,
    "replyMessage" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ThreadsCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThreadsReplyLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadsCampaignId" TEXT NOT NULL,
    "threadsAccountId" TEXT NOT NULL,
    "replyId" TEXT NOT NULL,
    "replyAuthorId" TEXT,
    "replyAuthorName" TEXT,
    "replyText" TEXT NOT NULL,
    "matchedKeyword" TEXT,
    "status" "ThreadsReplyStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "publishedReplyId" TEXT,
    "replySentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ThreadsReplyLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProcessedThreadsReply" (
    "id" TEXT NOT NULL,
    "threadsAccountId" TEXT NOT NULL,
    "replyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcessedThreadsReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ThreadsAccount_threadsUserId_key" ON "ThreadsAccount"("threadsUserId");
CREATE INDEX "ThreadsAccount_workspaceId_idx" ON "ThreadsAccount"("workspaceId");
CREATE INDEX "ThreadsCampaign_workspaceId_idx" ON "ThreadsCampaign"("workspaceId");
CREATE INDEX "ThreadsCampaign_threadsAccountId_idx" ON "ThreadsCampaign"("threadsAccountId");
CREATE INDEX "ThreadsCampaign_postId_idx" ON "ThreadsCampaign"("postId");
CREATE UNIQUE INDEX "ThreadsReplyLog_threadsCampaignId_replyId_key" ON "ThreadsReplyLog"("threadsCampaignId", "replyId");
CREATE INDEX "ThreadsReplyLog_workspaceId_idx" ON "ThreadsReplyLog"("workspaceId");
CREATE INDEX "ThreadsReplyLog_threadsAccountId_idx" ON "ThreadsReplyLog"("threadsAccountId");
CREATE INDEX "ThreadsReplyLog_status_idx" ON "ThreadsReplyLog"("status");
CREATE UNIQUE INDEX "ProcessedThreadsReply_threadsAccountId_replyId_key" ON "ProcessedThreadsReply"("threadsAccountId", "replyId");
CREATE INDEX "ProcessedThreadsReply_threadsAccountId_idx" ON "ProcessedThreadsReply"("threadsAccountId");

ALTER TABLE "ThreadsAccount" ADD CONSTRAINT "ThreadsAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadsCampaign" ADD CONSTRAINT "ThreadsCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadsCampaign" ADD CONSTRAINT "ThreadsCampaign_threadsAccountId_fkey" FOREIGN KEY ("threadsAccountId") REFERENCES "ThreadsAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadsReplyLog" ADD CONSTRAINT "ThreadsReplyLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadsReplyLog" ADD CONSTRAINT "ThreadsReplyLog_threadsCampaignId_fkey" FOREIGN KEY ("threadsCampaignId") REFERENCES "ThreadsCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreadsReplyLog" ADD CONSTRAINT "ThreadsReplyLog_threadsAccountId_fkey" FOREIGN KEY ("threadsAccountId") REFERENCES "ThreadsAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessedThreadsReply" ADD CONSTRAINT "ProcessedThreadsReply_threadsAccountId_fkey" FOREIGN KEY ("threadsAccountId") REFERENCES "ThreadsAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
