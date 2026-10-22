SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE "user_professional_use_acceptances"
  ADD COLUMN "source" text;
--> statement-breakpoint

-- Release the metadata-only ADD COLUMN lock before filling the small table.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
UPDATE "user_professional_use_acceptances"
SET "source" = 'recorded_before_provenance'
WHERE "source" IS NULL;
--> statement-breakpoint

-- Release row locks before installing the constraint.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances"
  ADD CONSTRAINT "user_professional_use_acceptances_source_values"
  CHECK (
    "source" IS NOT NULL
    AND "source" IN ('interactive', 'registration', 'recorded_before_provenance', 'owner_backfill_2026_10_22')
  ) NOT VALID;
--> statement-breakpoint

-- Validation scans under a weaker lock in its own transaction.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances"
  VALIDATE CONSTRAINT "user_professional_use_acceptances_source_values";
--> statement-breakpoint

-- PostgreSQL uses the validated check to avoid a table scan for SET NOT NULL.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances"
  ALTER COLUMN "source" SET NOT NULL;
