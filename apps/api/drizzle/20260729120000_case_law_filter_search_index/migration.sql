SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Filter-only case-law search has no full-text predicate: it reads newest
-- decisions by their authoritative (updated_at, id). Build the matching index
-- without blocking reads or ingestion on the existing public corpus table.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build,
-- then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup targets
-- only this migration's temporary replacement index. A cancelled concurrent
-- build can leave an INVALID index that blocks recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_updated_id_idx_replacement";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_updated_id_idx_replacement"
  ON "case_law_decisions" ("updated_at" DESC, "id" DESC);
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - replace only this
-- migration's previous index after its successor has finished building.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_updated_id_idx";
--> statement-breakpoint
ALTER INDEX "case_law_decisions_updated_id_idx_replacement"
  RENAME TO "case_law_decisions_updated_id_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
