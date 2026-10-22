SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- A constant default is stored in the catalog without rewriting the table, so
-- this is a metadata-only change. Existing rows read the default, and the
-- previous release, which does not write the column, keeps inserting valid
-- rows while instances roll over: the column is never NULL at any point.
-- Every stage below commits on its own and is safe to run again, so a retry
-- after a failure in a later stage resumes instead of failing here.
ALTER TABLE "user_professional_use_acceptances"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'recorded_before_provenance';
--> statement-breakpoint

-- Release the ADD COLUMN lock before installing the constraint.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the constraint exists only after an interrupted earlier run of this same migration; it is re-added NOT VALID in the same transaction, so no running task ever sees the table without it, and a failure rolls both statements back together.
ALTER TABLE "user_professional_use_acceptances"
  DROP CONSTRAINT IF EXISTS "user_professional_use_acceptances_source_values";
--> statement-breakpoint
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
