-- AlterTable
ALTER TABLE "ThreadsReplyLog"
ADD COLUMN "replyMessage" TEXT,
ADD COLUMN "publishLeaseToken" TEXT,
ADD COLUMN "publishLeaseExpiresAt" TIMESTAMP(3);
