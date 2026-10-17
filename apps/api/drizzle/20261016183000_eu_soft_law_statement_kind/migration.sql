-- requires: 20261004104100_soft_law_corpus
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - atomically replaces the kind check with a superset; existing writers and rollback builds retain every previously accepted value.
ALTER TABLE "soft_law_documents"
  DROP CONSTRAINT "soft_law_documents_kind_check",
  ADD CONSTRAINT "soft_law_documents_kind_check"
    CHECK ("kind" IN ('methodology','recommendation','opinion','faq','guideline','position','statement','inspection_report','annual_report','other'));
--> statement-breakpoint
ALTER TABLE "soft_law_document_versions"
  ADD COLUMN "extraction_failure" text,
  ADD CONSTRAINT "soft_law_versions_extraction_failure_check"
    CHECK ("extraction_failure" IS NULL OR ("extraction_quality" = 'extraction_failed' AND length(btrim("extraction_failure")) > 0));
--> statement-breakpoint
ALTER TABLE "soft_law_ingestion_attempts"
  ADD COLUMN "raw_objects" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - atomically extends retryable receipts to count zero for deferred work; old positive attempt counts remain valid and no records are removed.
ALTER TABLE "soft_law_ingestion_attempts"
  DROP CONSTRAINT "soft_law_attempts_count_check",
  ADD CONSTRAINT "soft_law_attempts_count_check"
    CHECK ("count" BETWEEN 0 AND 3 AND ("count" > 0 OR "status" = 'retryable'));
