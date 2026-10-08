SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- requires: 20261007154000_signals_flows_enrolments
-- Upload replay checks its durable source identity under the definition lock.
-- Build the lookup index without blocking active runs.
-- Drizzle wraps migrations in a transaction; PostgreSQL requires concurrent
-- index operations outside that transaction.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Retry cleanup removes
-- only this migration's index if a cancelled concurrent build left it invalid.
DROP INDEX CONCURRENTLY IF EXISTS "flow_runs_upload_identity_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "flow_runs_upload_identity_idx"
  ON "flow_runs" ("definition_id", "workspace_id", ("trigger_source"->>'entityId'))
  WHERE "trigger_source"->>'type' = 'file-upload';
--> statement-breakpoint

-- Scheduled delivery replays keep the original due slot across retries.
DROP INDEX CONCURRENTLY IF EXISTS "flow_runs_schedule_identity_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "flow_runs_schedule_identity_idx"
  ON "flow_runs" ("definition_id", "workspace_id", ("trigger_source"->>'dueSlot'))
  WHERE "trigger_source"->>'type' = 'schedule'
    AND "trigger_source"->>'dueSlot' IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
