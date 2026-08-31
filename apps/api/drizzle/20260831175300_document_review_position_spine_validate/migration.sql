SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- Validate the constraints the position-spine migrations added NOT VALID, now
-- that the backfills they describe have committed. A separate migration so a
-- long validation scan cannot hold the lock the schema changes needed.
ALTER TABLE "document_review_runs"
  VALIDATE CONSTRAINT "document_review_runs_basis_shape_check";--> statement-breakpoint

ALTER TABLE "document_review_findings"
  VALIDATE CONSTRAINT "document_review_findings_outcome_check";
