-- requires: 20261010005400_upload_trigger_settlements
-- requires: 20261010005500_feature_recovery_grant_waits
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate in the migrator transaction without retaining the preceding DDL locks.
ALTER TABLE "pending_scout_emissions"
  VALIDATE CONSTRAINT "pending_scout_emissions_status_check";
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents"
  VALIDATE CONSTRAINT "flow_upload_trigger_intents_settlement_check";
--> statement-breakpoint
ALTER TABLE "document_processing_runs"
  VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_status_values_check",
  VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check";
