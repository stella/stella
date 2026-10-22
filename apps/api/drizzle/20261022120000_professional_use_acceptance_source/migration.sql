SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- A constant default is stored in the catalog without rewriting the table, so
-- this is a metadata-only change. Existing rows read the default, and the
-- previous release, which does not write the column, keeps inserting valid
-- rows while instances roll over: the column is never NULL at any point.
ALTER TABLE "user_professional_use_acceptances"
  ADD COLUMN "source" text NOT NULL DEFAULT 'recorded_before_provenance';
--> statement-breakpoint

-- Release the ADD COLUMN lock before installing the constraint.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances"
  ADD CONSTRAINT "user_professional_use_acceptances_source_values"
  CHECK (
    "source" IN ('interactive', 'registration', 'recorded_before_provenance', 'owner_backfill_2026_10_22')
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
