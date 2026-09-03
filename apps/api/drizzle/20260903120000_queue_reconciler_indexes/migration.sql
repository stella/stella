SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent builds
-- (which take no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260901190000_case_law_decisions_country_court_date_idx.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Each build drops only its own index by name first: a cancelled concurrent
-- build leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it.

DROP INDEX CONCURRENTLY IF EXISTS "document_review_runs_queued_worker_idx";
--> statement-breakpoint
-- The reconciler walks runs still waiting for a worker in creation order,
-- keyset-paginated, and stops at its page. Without this the walk sorts the
-- whole run history on every sweep. Partial on the two columns the sweep
-- filters, so the index stays the size of the outstanding work: a table-
-- executed run is paced by the files-table property DAG and was never handed
-- to that queue.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_review_runs_queued_worker_idx"
  ON "document_review_runs" ("created_at", "id")
  WHERE "status" = 'queued' AND "executor" = 'worker';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "bilingual_translation_runs_queued_idx";
--> statement-breakpoint
-- Same walk, same reason, for bilingual runs.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "bilingual_translation_runs_queued_idx"
  ON "bilingual_translation_runs" ("created_at", "id")
  WHERE "status" = 'queued';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "style_sets_pending_package_cleanup_idx";
--> statement-breakpoint
-- The cleanup reconciler walks the rows that still name a superseded package,
-- oldest first. Those are a vanishing fraction of the table, so the partial
-- predicate is what keeps the sweep off a full scan.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "style_sets_pending_package_cleanup_idx"
  ON "style_sets" ("updated_at", "id")
  WHERE "cleanup_s3_key" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
