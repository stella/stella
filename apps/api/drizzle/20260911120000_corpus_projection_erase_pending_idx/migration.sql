SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260906120000_corpus_projection_outstanding_intent_idx.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Drop by name first: a cancelled concurrent build leaves an INVALID index
-- behind, and IF NOT EXISTS would then skip recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_states_erase_pending_idx";
--> statement-breakpoint
-- Every projection cycle of every generation claims the erasures that
-- generation still owes, in pending-queue order. No partial index on this
-- table matched that predicate: the pending, route and census indexes are
-- keyed on work_status or on applied_action = 'upsert', neither of which the
-- erasure predicate implies, so the claim read the whole table on every call
-- even with nothing pending erasure. Keyed on the generation it claims within
-- plus that queue order and partial on the answer, the claim reads the
-- pending erasures alone. The predicate is generated from the expression the
-- claim uses (corpusIndexProjectionErasureIsPending), which is what lets
-- PostgreSQL prove the implication; the claim writes the action as a literal
-- for the same reason, because a generic plan over a bound parameter proves
-- nothing.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "corpus_index_projection_states_erase_pending_idx"
  ON "corpus_index_projection_states" ("family", "generation", "updated_at", "entity_id")
  WHERE "desired_action" = 'erase'
    AND (
      "applied_action" IS DISTINCT FROM 'erase'
      OR "applied_epoch" IS DISTINCT FROM "desired_epoch"
    );
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
