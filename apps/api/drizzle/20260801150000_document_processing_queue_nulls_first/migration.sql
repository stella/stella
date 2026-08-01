SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Queued OCR dispatch orders undated work first, followed by the earliest
-- retry deadline. Rebuild the partial scheduling index with the same NULLS
-- FIRST ordering so each bounded batch can use an index scan.
-- Drizzle wraps migrations in a transaction; PostgreSQL requires concurrent
-- index operations outside it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - replaces only this queue scheduling index so an interrupted concurrent build is retried safely.
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_queued_schedule_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "document_processing_runs_queued_schedule_idx"
  ON "document_processing_runs" ("next_attempt_at" ASC NULLS FIRST, "created_at", "id")
  WHERE "status" = 'queued';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
