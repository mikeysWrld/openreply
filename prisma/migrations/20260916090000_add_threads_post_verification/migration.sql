ALTER TABLE "ThreadsCampaign"
ADD COLUMN "postVerifiedAt" TIMESTAMP(3);

-- Legacy specific-post campaigns have no server-side ownership provenance, so
-- pause only active specific campaigns until an authenticated activation
-- verifies their target. All-post campaigns do not require post ownership.
UPDATE "ThreadsCampaign"
SET "isActive" = false
WHERE "isActive" = true
  AND "matchAnyPost" = false;
