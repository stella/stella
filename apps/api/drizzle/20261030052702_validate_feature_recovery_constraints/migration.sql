-- requires: 20261030052002_upload_trigger_settlements
-- requires: 20261030052102_feature_recovery_grant_waits
-- requires: 20261030052302_flow_recovery_outcomes
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';

-- Constraint validation runs in the registered online phase.
