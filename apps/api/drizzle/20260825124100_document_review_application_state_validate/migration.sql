SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Kept in a separate transaction from the ADD ... NOT VALID migration. The
-- new columns give every existing row pending/null application state, and the
-- constraints enforce all later writes immediately, so this bounded scan
-- cannot find an older incompatible row.
ALTER TABLE "document_review_findings"
  VALIDATE CONSTRAINT "document_review_findings_application_status_values_check";--> statement-breakpoint

ALTER TABLE "document_review_findings"
  VALIDATE CONSTRAINT "document_review_findings_application_timing_check";--> statement-breakpoint

ALTER TABLE "document_review_findings"
  VALIDATE CONSTRAINT "document_review_findings_applied_by_user_id_fk";
