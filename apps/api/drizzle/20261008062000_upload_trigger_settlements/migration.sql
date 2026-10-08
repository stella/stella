-- requires: 20261007154000_signals_flows_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents"
  ADD COLUMN "status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN "skip_reason" text;
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents"
  ADD CONSTRAINT "flow_upload_trigger_intents_settlement_check" CHECK (
    (status = 'pending' AND skip_reason IS NULL) OR
    (status = 'skipped' AND skip_reason IS NOT NULL AND skip_reason IN ('definition_disabled', 'trigger_no_longer_matches'))
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents"
  VALIDATE CONSTRAINT "flow_upload_trigger_intents_settlement_check";
--> statement-breakpoint
-- Retained terminal receipts must not enlarge the pending recovery scan.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
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
