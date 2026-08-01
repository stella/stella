SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Historical tombstones are repaired by a bounded scheduler task. Give that
-- keyset walk a partial audit index without blocking append-only writers.
-- Drizzle wraps migrations in a transaction; PostgreSQL requires concurrent
-- index builds outside it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - drops only this migration's index name so an interrupted INVALID concurrent build is rebuilt safely.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_index_jobs_redaction_decision_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "case_law_index_jobs_redaction_decision_idx"
  ON "case_law_index_jobs" ("decision_id", "created_at" DESC)
  WHERE "operation" = 'redact' AND "decision_id" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
