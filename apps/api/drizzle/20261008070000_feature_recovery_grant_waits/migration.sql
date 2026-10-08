-- requires: 20261008062000_upload_trigger_settlements
-- requires: 20261005140100_validate_deadline_scout_skipped_until
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Existing receipts remain pending; grant waits are written only by the new workers.
ALTER TABLE "pending_scout_emissions"
  ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "pending_scout_emissions"
  ADD CONSTRAINT "pending_scout_emissions_status_check"
  CHECK (status IN ('pending', 'awaiting_grant')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "pending_scout_emissions"
  VALIDATE CONSTRAINT "pending_scout_emissions_status_check";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replaces only the receipt lifecycle check with a wider grant-wait state in the same transaction; existing pending and skipped rows remain valid.
ALTER TABLE "flow_upload_trigger_intents"
  DROP CONSTRAINT "flow_upload_trigger_intents_settlement_check",
  ADD CONSTRAINT "flow_upload_trigger_intents_settlement_check" CHECK (
    (status IN ('pending', 'awaiting_grant') AND skip_reason IS NULL) OR
    (status = 'skipped' AND skip_reason IS NOT NULL AND skip_reason IN ('definition_disabled', 'trigger_no_longer_matches'))
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents"
  VALIDATE CONSTRAINT "flow_upload_trigger_intents_settlement_check";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Widens the deadline lifecycle to an unclaimed feature refusal; replaces both checks atomically and preserves every existing state.
ALTER TABLE "document_processing_runs"
  DROP CONSTRAINT "document_processing_runs_deadline_scout_status_values_check",
  DROP CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check",
  ADD CONSTRAINT "document_processing_runs_deadline_scout_status_values_check"
    CHECK (deadline_scout_status IN ('not_requested', 'pending', 'awaiting_grant', 'running', 'succeeded', 'failed', 'cancelled')) NOT VALID,
  ADD CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check" CHECK (
    (deadline_scout_status = 'not_requested' AND deadline_scout_claimed_at IS NULL AND deadline_scout_error_code IS NULL)
    OR (deadline_scout_status = 'pending' AND deadline_scout_claimed_at IS NULL)
    OR (deadline_scout_status = 'awaiting_grant' AND deadline_scout_claimed_at IS NULL AND deadline_scout_error_code IS NOT NULL AND deadline_scout_error_code = 'feature_not_granted')
    OR (deadline_scout_status = 'running' AND deadline_scout_claimed_at IS NOT NULL AND deadline_scout_error_code IS NULL)
    OR (deadline_scout_status IN ('succeeded', 'cancelled') AND deadline_scout_claimed_at IS NULL)
    OR (deadline_scout_status = 'failed' AND deadline_scout_claimed_at IS NULL AND deadline_scout_error_code IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_processing_runs"
  VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_status_values_check",
  VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check";
--> statement-breakpoint

-- Build grant-wakeup indexes and replace the retry index without blocking receipt writes.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "pending_scout_emissions_next_attempt_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "pending_scout_emissions_next_attempt_idx"
  ON "pending_scout_emissions" ("next_attempt_at") WHERE "status" = 'pending';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "pending_scout_emissions_awaiting_grant_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "pending_scout_emissions_awaiting_grant_idx"
  ON "pending_scout_emissions" ("organization_id", "workspace_id") WHERE "status" = 'awaiting_grant';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "flow_upload_trigger_intents_awaiting_grant_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_awaiting_grant_idx"
  ON "flow_upload_trigger_intents" ("organization_id", "workspace_id") WHERE "status" = 'awaiting_grant';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_deadline_scout_awaiting_grant_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_processing_runs_deadline_scout_awaiting_grant_idx"
  ON "document_processing_runs" ("organization_id", "workspace_id", "id") WHERE "deadline_scout_status" = 'awaiting_grant';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
