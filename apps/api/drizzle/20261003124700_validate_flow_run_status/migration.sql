-- requires: 20261003124600_flow_run_transitions
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "flow_runs" VALIDATE CONSTRAINT "flow_runs_status_domain";
