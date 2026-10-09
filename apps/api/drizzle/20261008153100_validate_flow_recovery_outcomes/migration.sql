-- requires: 20261008153000_flow_recovery_outcomes
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- Commit the prerequisite before validation can scan existing sources.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = 0;--> statement-breakpoint
ALTER TABLE "flow_runs" VALIDATE CONSTRAINT "flow_runs_recovery_state_check";
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents" VALIDATE CONSTRAINT "flow_upload_trigger_intents_settlement_check";
--> statement-breakpoint
ALTER TABLE "document_processing_runs" VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_skip_check";
