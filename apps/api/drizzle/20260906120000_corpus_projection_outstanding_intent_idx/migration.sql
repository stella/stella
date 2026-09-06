SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260903120000_queue_reconciler_indexes.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Drop by name first: a cancelled concurrent build leaves an INVALID index
-- behind, and IF NOT EXISTS would then skip recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_intents_outstanding_idx";
--> statement-breakpoint
-- The append and erasure queues ask, per candidate entity, whether any of its
-- revisions is still short of a terminal status. Only
-- corpus_index_projection_intents_entity_idx could answer that, and its key
-- carries no status, so the probe read every revision the entity ever had and
-- checked each status in the heap. Settled revisions are never deleted, so
-- that cost grows with how often the generation has been re-projected rather
-- than with the work outstanding. Keyed on the identity the probe supplies and
-- partial on the answer, the scan sees the outstanding revisions alone. The
-- predicate is generated from the expression the queries use
-- (corpusIndexProjectionIntentIsOutstanding), which is what lets PostgreSQL
-- prove the implication and drop the status recheck.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_outstanding_idx"
  ON "corpus_index_projection_intents" ("family", "generation", "entity_id", "epoch")
  WHERE "status" NOT IN ('settled', 'cancelled');
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
