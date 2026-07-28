SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The corpus indexer's missing scan selects rows whose indexed_generation is
-- unset (or belongs to an older generation). Neither predicate is served by an
-- index, so every selection pays a heap scan that grows with each row already
-- marked; on the full corpus that starves both bulk builds and the daemon's
-- steady-state loop. The partial index below covers the dominant arm
-- (never-indexed rows) and stays proportional to the remaining work: it
-- shrinks toward empty as the build completes.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent builds
-- (which are expected to outlive a 5s statement_timeout and take no lock those
-- timeouts guard), then restore and reopen a transaction for Drizzle's
-- migration row. Same shape as 20260720140000_machine_api_keys_org_index.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before recreating it. A cancelled concurrent
-- build leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it; dropping first means a retry cannot record the migration
-- while the scan is unindexed.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_pending_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_pending_idx" ON "case_law_decisions" ("id") WHERE "content_hash" IS NOT NULL AND "indexed_generation" IS NULL;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - same reasoning as
-- the index above, for the legislation twin.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_corpus_pending_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_corpus_pending_idx" ON "legislation_documents" ("id") WHERE "content_hash" IS NOT NULL AND "indexed_generation" IS NULL;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
