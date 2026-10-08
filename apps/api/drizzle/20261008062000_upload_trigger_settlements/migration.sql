-- requires: 20261007154000_signals_flows_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The index phase can fail after DDL commits; these statements must tolerate replay.
ALTER TABLE "flow_upload_trigger_intents"
  ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "skip_reason" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'flow_upload_trigger_intents'::regclass
      AND conname = 'flow_upload_trigger_intents_settlement_check'
  ) THEN
    ALTER TABLE "flow_upload_trigger_intents"
      ADD CONSTRAINT "flow_upload_trigger_intents_settlement_check" CHECK (
        (status = 'pending' AND skip_reason IS NULL) OR
        (status = 'skipped' AND skip_reason IS NOT NULL AND skip_reason IN ('definition_disabled', 'trigger_no_longer_matches'))
      ) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
-- Retained terminal receipts must not enlarge the pending recovery scan.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so the scan does not retain DDL locks.
ALTER TABLE "flow_upload_trigger_intents"
  VALIDATE CONSTRAINT "flow_upload_trigger_intents_settlement_check";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "flow_upload_trigger_intents_retry_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_retry_idx"
  ON "flow_upload_trigger_intents" ("retry_at", "definition_id", "entity_id")
  WHERE "status" = 'pending';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
