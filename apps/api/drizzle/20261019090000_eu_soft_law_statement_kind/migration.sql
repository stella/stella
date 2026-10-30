-- requires: 20261004104100_soft_law_corpus
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Every statement before the COMMIT below is guarded: a failure after the
-- COMMIT replays the whole file.
-- stella-migration-safety: reviewed drop-constraint - replaces the kind check with a superset in the same transaction; existing writers and rollback builds retain every previously accepted value.
ALTER TABLE "soft_law_documents"
  DROP CONSTRAINT IF EXISTS "soft_law_documents_kind_check";
--> statement-breakpoint
ALTER TABLE "soft_law_documents"
  ADD CONSTRAINT "soft_law_documents_kind_check"
    CHECK ("kind" IN ('methodology','recommendation','opinion','faq','guideline','position','statement','inspection_report','annual_report','other')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "soft_law_document_versions"
  ADD COLUMN IF NOT EXISTS "extraction_failure" text;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - removes only this migration's own check from an interrupted earlier run before adding it again.
ALTER TABLE "soft_law_document_versions"
  DROP CONSTRAINT IF EXISTS "soft_law_versions_extraction_failure_check";
--> statement-breakpoint
ALTER TABLE "soft_law_document_versions"
  ADD CONSTRAINT "soft_law_versions_extraction_failure_check"
    CHECK ("extraction_failure" IS NULL OR ("extraction_quality" = 'extraction_failed' AND length(btrim("extraction_failure")) > 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "soft_law_ingestion_attempts"
  ADD COLUMN IF NOT EXISTS "raw_objects" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - extends retryable receipts to count zero for deferred work in the same transaction; old positive attempt counts remain valid and no records are removed.
ALTER TABLE "soft_law_ingestion_attempts"
  DROP CONSTRAINT IF EXISTS "soft_law_attempts_count_check";
--> statement-breakpoint
ALTER TABLE "soft_law_ingestion_attempts"
  ADD CONSTRAINT "soft_law_attempts_count_check"
    CHECK ("count" BETWEEN 0 AND 3 AND ("count" > 0 OR "status" = 'retryable')) NOT VALID;
--> statement-breakpoint

-- Release the ADD CONSTRAINT locks before scanning existing rows.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint

ALTER TABLE "soft_law_documents"
  VALIDATE CONSTRAINT "soft_law_documents_kind_check";
--> statement-breakpoint
ALTER TABLE "soft_law_document_versions"
  VALIDATE CONSTRAINT "soft_law_versions_extraction_failure_check";
--> statement-breakpoint
ALTER TABLE "soft_law_ingestion_attempts"
  VALIDATE CONSTRAINT "soft_law_attempts_count_check";
