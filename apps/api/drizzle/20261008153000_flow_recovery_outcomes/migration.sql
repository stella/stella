-- requires: 20261008070000_feature_recovery_grant_waits
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "recovery_state" text;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces only the recovery-state check; nullable existing rows keep their current run status.
ALTER TABLE "flow_runs"
  DROP CONSTRAINT IF EXISTS "flow_runs_recovery_state_check",
  ADD CONSTRAINT "flow_runs_recovery_state_check" CHECK (
    recovery_state IS NULL OR
    (status IN ('failed', 'completed', 'awaiting_review') AND recovery_state = 'actor-removed') OR
    (status = 'completed' AND recovery_state = 'completion-notice-pending')
  ) NOT VALID;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Widens retained receipt reasons without changing their pending or skipped lifecycle.
ALTER TABLE "flow_upload_trigger_intents"
  DROP CONSTRAINT IF EXISTS "flow_upload_trigger_intents_settlement_check",
  ADD CONSTRAINT "flow_upload_trigger_intents_settlement_check" CHECK (
    (status IN ('pending', 'awaiting_grant') AND skip_reason IS NULL) OR
    (status = 'skipped' AND skip_reason IS NOT NULL AND skip_reason IN ('definition_disabled', 'actor_missing', 'trigger_no_longer_matches'))
  ) NOT VALID;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Grant pauses retain existing scout backoff; every other lifecycle condition is unchanged.
ALTER TABLE "document_processing_runs"
  DROP CONSTRAINT IF EXISTS "document_processing_runs_deadline_scout_skip_check",
  ADD CONSTRAINT "document_processing_runs_deadline_scout_skip_check" CHECK (
    deadline_scout_skipped_until IS NULL OR
    (deadline_scout_status IN ('pending', 'awaiting_grant') AND deadline_scout_error_code IS NOT NULL)
  ) NOT VALID;
