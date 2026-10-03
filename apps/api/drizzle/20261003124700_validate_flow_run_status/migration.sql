-- requires: 20261003124600_flow_run_transitions
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Commit the prerequisite and its migration receipt before validation.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "flow_runs" VALIDATE CONSTRAINT "flow_runs_status_domain";
--> statement-breakpoint
ALTER TABLE "flow_run_steps" VALIDATE CONSTRAINT "flow_run_steps_status_domain";
