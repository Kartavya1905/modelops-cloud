-- AlterTable
ALTER TABLE "deployment_revisions" ADD COLUMN     "stable_at" TIMESTAMPTZ(3);


-- Backfill: before M8 every READY revision took over as stable (blue/green), so it served as
-- stable from the moment it was ready.
UPDATE "deployment_revisions"
   SET "stable_at" = "ready_at"
 WHERE "ready_at" IS NOT NULL AND "strategy" = 'IMMEDIATE';
