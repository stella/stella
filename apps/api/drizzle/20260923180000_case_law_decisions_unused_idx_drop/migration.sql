SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Indexes no query can use any more:
-- - `authority_due_idx` ordered the authority sweep by its per-row stamp; the
--   sweep now walks by primary key and keeps its position in
--   `case_law_citation_authority_sweep`.
-- - `indexed_idx`, `corpus_pending_idx` and `corpus_hash_pending_idx` index
--   the retired projection markers, which nothing reads.
-- - `document_pending_idx` is the attempt-led order that
--   `document_pending_date_idx` replaced; its removal condition (every runner
--   on the date-led order) has held since that release shipped.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires DROP INDEX CONCURRENTLY to run outside a transaction block. Split
-- the migrator transaction, lift the statement budget for the concurrent
-- drops, then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - no query orders or filters by this index any more; rollback recreates it with CREATE INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_authority_due_idx";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - indexes retired columns nothing reads; rollback recreates it with CREATE INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_indexed_idx";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - no query carries its predicate on a retired column; rollback recreates it with CREATE INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_pending_idx";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - no query carries its predicate on a retired column; rollback recreates it with CREATE INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_hash_pending_idx";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - superseded by the date-led index with the same predicate; rollback recreates it with CREATE INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_document_pending_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
