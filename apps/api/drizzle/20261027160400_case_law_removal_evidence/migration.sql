-- requires: 20261027160300_case_law_removal_retry_lane
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - The CHECK is replaced atomically in this migration; running writers keep their allowed values, and rollback restores the original constraint.
ALTER TABLE "case_law_reconciliation_items" DROP CONSTRAINT "case_law_reconciliation_items_kind_values";--> statement-breakpoint
ALTER TABLE "case_law_reconciliation_items" ADD CONSTRAINT "case_law_reconciliation_items_kind_values"
  CHECK ("kind" IN ('listing', 'removal-erasure', 'removal-pending', 'removal-unprobeable')) NOT VALID;
