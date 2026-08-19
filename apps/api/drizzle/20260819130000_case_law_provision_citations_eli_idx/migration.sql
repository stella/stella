SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Access paths for the incoming-citations read when it is keyed by the work's
-- identifier rather than by the display citation a decision's text states. A
-- reader arriving from the act has only the ELI, and without these the walk
-- degrades into a full scan of the jurisdiction's references on an
-- unauthenticated path.
--
-- Partial on a stated ELI: a reference to a work the corpus does not hold
-- carries none, and those rows can never be the answer to this walk.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent
-- builds, then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- The whole work, newest application first: the leading pair seeks and the
-- rest is both the sort and the cursor, so a page stops at the limit.
-- stella-migration-safety: reviewed destructive-change - this retry cleanup
-- targets only this migration's index; a cancelled concurrent build can leave
-- an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_provision_citations_eli_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_provision_citations_eli_idx"
  ON "case_law_provision_citations" (
    "jurisdiction",
    "work_eli",
    (coalesce("decision_date", '0001-01-01'::date)) DESC,
    "decision_id" DESC,
    "span_start" DESC,
    "anchor" DESC
  )
  WHERE "work_eli" IS NOT NULL;
--> statement-breakpoint

-- One provision of the work, same order. The anchor sits directly after the
-- work so a single provision is a seek rather than a filter over the act.
-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_provision_citations_eli_anchor_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_provision_citations_eli_anchor_idx"
  ON "case_law_provision_citations" (
    "jurisdiction",
    "work_eli",
    "anchor",
    (coalesce("decision_date", '0001-01-01'::date)) DESC,
    "decision_id" DESC,
    "span_start" DESC
  )
  WHERE "work_eli" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
