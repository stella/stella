-- requires: 20261022120000_professional_use_acceptance_source
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Allow the source the review-account operator command records. The check is
-- replaced in one transaction, so no running task ever sees the table without
-- it; it is installed NOT VALID and validated in its own transaction below.
-- Every stage is safe to run again.
-- stella-migration-safety: reviewed drop-constraint - the constraint is re-added NOT VALID in the same transaction with one more allowed value, so no running task ever sees the table without it, and a failure rolls both statements back together.
ALTER TABLE "user_professional_use_acceptances"
  DROP CONSTRAINT IF EXISTS "user_professional_use_acceptances_source_values";
--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances"
  ADD CONSTRAINT "user_professional_use_acceptances_source_values"
  CHECK (
    "source" IN ('interactive', 'registration', 'recorded_before_provenance', 'owner_backfill_2026_10_22', 'operator_provisioning')
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
