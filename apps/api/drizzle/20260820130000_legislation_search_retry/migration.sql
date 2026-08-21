SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legislation_search_documents"
  ADD COLUMN IF NOT EXISTS "retry_after" timestamptz;--> statement-breakpoint

-- Drizzle wraps migrations in a transaction, while PostgreSQL requires the
-- retry index to build concurrently on the existing projection table.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - removes only this
-- migration's index so a cancelled INVALID build can be retried.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_search_docs_retry_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_search_docs_retry_idx"
  ON "legislation_search_documents" ("retry_after", "document_id")
  WHERE "retry_after" IS NOT NULL;--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
