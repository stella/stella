-- requires: 20261003122600_timer_admin_stop
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
-- Nullable columns preserve legacy approval state without inventing an actor.
ALTER TABLE "time_entries"
  ADD COLUMN IF NOT EXISTS "approver_user_id" text,
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "approved_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "returned_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "returned_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "return_comment" text;
--> statement-breakpoint
-- The additive prefix is replayable if an online build is interrupted.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "time_entries_approval_queue_idx"
  ON "time_entries" ("organization_id", "approver_user_id", "status", "date_worked", "id") WHERE "status" = 'draft';
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "time_entries_approval_queue_idx";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approver_user_id_user_id_fk"
  FOREIGN KEY ("approver_user_id") REFERENCES "user"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
-- All pre-existing provenance columns are NULL; no historical scan is needed.
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approval_provenance_check"
  CHECK (("approved_by_user_id" IS NULL AND "approved_at" IS NULL)
    OR ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "status" IN ('approved', 'billed', 'written_off'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_return_metadata_check"
  CHECK (("returned_by_user_id" IS NULL AND "returned_at" IS NULL AND "return_comment" IS NULL)
    OR ("returned_by_user_id" IS NOT NULL AND "returned_at" IS NOT NULL AND "return_comment" IS NOT NULL
      AND char_length(btrim("return_comment")) BETWEEN 1 AND 2000
      AND char_length("return_comment") <= 2000)) NOT VALID;
