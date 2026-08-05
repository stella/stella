SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "document_processing_runs"
  DROP CONSTRAINT "document_processing_runs_kind_values_check";--> statement-breakpoint
ALTER TABLE "document_processing_runs"
  ADD CONSTRAINT "document_processing_runs_kind_values_check"
  CHECK ("kind" IN ('native-extraction', 'ocr')) NOT VALID;--> statement-breakpoint

-- Drizzle wraps migrations in a transaction. Validate outside it so existing
-- document-processing rows do not hold a long blocking lock during rollout.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
ALTER TABLE "document_processing_runs"
  VALIDATE CONSTRAINT "document_processing_runs_kind_values_check";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "fields_document_processing_native_candidate_idx"
  ON "fields" ("id", "workspace_id", "entity_version_id")
  WHERE "content"->>'type' = 'file'
    AND "content"->>'encrypted' = 'false';
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - replaces the PDF-only recovery index with the broader native-extraction recovery index.
DROP INDEX CONCURRENTLY IF EXISTS "fields_document_processing_pdf_candidate_idx";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
