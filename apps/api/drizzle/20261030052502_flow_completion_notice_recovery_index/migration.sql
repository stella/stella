-- requires: 20261030052302_flow_recovery_outcomes
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';

-- Index construction runs in the registered online phase.
