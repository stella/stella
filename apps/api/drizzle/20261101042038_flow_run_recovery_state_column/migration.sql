-- requires: 20261101041938_feature_recovery_grant_waits
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "recovery_state" text;
