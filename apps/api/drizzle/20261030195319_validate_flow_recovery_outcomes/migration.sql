-- requires: 20261030195219_flow_recovery_outcomes
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';

-- Constraint validation runs in the registered online phase.
