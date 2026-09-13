ALTER TABLE "ThreadsCampaign"
ADD COLUMN "activatedAt" TIMESTAMP(3);

UPDATE "ThreadsCampaign"
SET "activatedAt" = CURRENT_TIMESTAMP
WHERE "isActive" = true;
