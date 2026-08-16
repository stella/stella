SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The citation-authority recompute was one UPDATE over every decision. On a
-- corpus this size that statement outruns its timeout and rolls back: it spent
-- the work and kept none of it, every time. It now runs in bounded batches,
-- least recently computed first, and `citation_authority_computed_at` is the
-- whole of the bookkeeping — recomputing a decision stamps it with the current
-- instant, which puts it past the sweep's staleness boundary and out of the
-- set being walked. The sweep therefore advances by doing its work and needs
-- no persisted cursor.
--
-- That only holds if the ordering is an index range rather than a sort of six
-- million rows, so the direction and null placement match the statement's
-- ORDER BY exactly. Never-computed rows sort first, which is what makes the
-- same mechanism serve the initial backfill: the column exists on every row
-- and has never been written.

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block. Split
-- the migrator transaction, lift the timeouts for the concurrent build, then
-- restore and reopen a transaction for Drizzle's migration row. Same shape as
-- 20260730180000_citation_key.
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
-- recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_authority_due_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_authority_due_idx" ON "case_law_decisions" ("citation_authority_computed_at" ASC NULLS FIRST,"id");--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
