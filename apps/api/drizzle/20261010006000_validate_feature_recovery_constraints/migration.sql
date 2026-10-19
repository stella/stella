-- requires: 20261010005400_upload_trigger_settlements
-- requires: 20261010005500_feature_recovery_grant_waits
-- requires: 20261010005600_flow_recovery_outcomes
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate without retaining the constraint DDL locks through the scan.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so the scan does not retain DDL locks.
ALTER TABLE "pending_scout_emissions" VALIDATE CONSTRAINT "pending_scout_emissions_status_check";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so the scan does not retain DDL locks.
ALTER TABLE "flow_upload_trigger_intents" VALIDATE CONSTRAINT "flow_upload_trigger_intents_settlement_check";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so the scan does not retain DDL locks.
ALTER TABLE "document_processing_runs" VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_status_values_check";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so the scan does not retain DDL locks.
ALTER TABLE "document_processing_runs" VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
