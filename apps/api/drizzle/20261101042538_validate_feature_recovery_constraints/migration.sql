-- requires: 20261101041838_upload_trigger_settlements
-- requires: 20261101041938_feature_recovery_grant_waits
-- requires: 20261101042138_flow_recovery_outcomes
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';

-- Constraint validation runs in the registered online phase.
