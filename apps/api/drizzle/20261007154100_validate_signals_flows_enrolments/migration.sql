-- requires: 20261007154000_signals_flows_enrolments
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = 0;--> statement-breakpoint
ALTER TABLE "feature_enrolments" VALIDATE CONSTRAINT "feature_enrolments_feature_id_check";
