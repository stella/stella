SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- Validate the foreign key the previous migration added NOT VALID. Every row
-- that predates it holds NULL there, so the scan finds nothing to reject; it
-- runs as its own migration so the scan cannot hold the lock the ADD COLUMN
-- needed.
ALTER TABLE "docx_suggestions"
  VALIDATE CONSTRAINT "docx_suggestions_origin_review_finding_fk";
