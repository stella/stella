-- OCR recovery reads only live, unencrypted PDF field candidates. Keep the
-- partial index bounded to that set and workspace-leading for tenant isolation.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps migrations in a transaction; concurrent builds cannot run in
-- one. A failed build can leave an INVALID index, so remove only this
-- migration's index before recreating it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "fields_document_processing_pdf_candidate_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "fields_document_processing_pdf_candidate_idx"
  ON "fields" ("workspace_id", "entity_version_id", "id")
  WHERE "content"->>'type' = 'file'
    AND "content"->>'mimeType' = 'application/pdf'
    AND "content"->>'encrypted' = 'false';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
