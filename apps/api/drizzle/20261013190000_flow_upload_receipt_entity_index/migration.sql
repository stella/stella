-- requires: 20261010005100_signals_flows_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Entity deletion resolves upload receipts through the composite source key.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Retrying a cancelled build replaces only this migration's index.
DROP INDEX CONCURRENTLY IF EXISTS "flow_upload_trigger_intents_entity_ws_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_entity_ws_idx"
  ON "flow_upload_trigger_intents" ("entity_id", "workspace_id");
--> statement-breakpoint

SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
