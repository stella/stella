-- requires: 20261003124600_flow_run_transitions
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Commit the prerequisite and its migration receipt before validation.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
-- Validation scans existing rows; lock acquisition remains bounded above.
SET LOCAL statement_timeout = 0;--> statement-breakpoint

ALTER TABLE "flow_runs" VALIDATE CONSTRAINT "flow_runs_status_domain";
--> statement-breakpoint
ALTER TABLE "flow_run_steps" VALIDATE CONSTRAINT "flow_run_steps_status_domain";
