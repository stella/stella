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
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_document_pending_date_idx";
--> statement-breakpoint
-- The deferred-document queue's remaining tier, re-keyed without
-- "document_fetch_attempts". Leading with the attempt count ordered every
-- decision that had already failed once behind the entire untried backlog, so
-- its retry waited for the backlog to drain rather than for its cooldown to
-- pass. The tier now orders by decision date alone (remainingDocumentOrder),
-- and the index has to match that order for the head of the queue to stay a
-- bounded range scan instead of a sort over the backlog. Same predicate, so
-- the index still covers exactly the pending set.
--
-- Built under a new name rather than replaced in place: the queue reads this
-- index every page, and a drop-then-build would leave it scanning the whole
-- table for as long as the build runs.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_document_pending_date_idx"
  ON "case_law_decisions" (
    "source_id",
    "decision_date" DESC NULLS LAST,
    "id"
  )
  WHERE "fulltext" is null AND "document_url" is not null;
--> statement-breakpoint
-- The superseded "case_law_decisions_document_pending_idx" is deliberately
-- left in place. A migration runs before the rolling deployment finishes, so
-- tasks still on the previous revision keep ordering the tier by attempt
-- count; dropping their index here would make each of their queue refills a
-- sort over the whole backlog until the last one is replaced.
--
-- Removal condition: every runner is on the order this migration's index
-- serves, i.e. the release carrying it is fully rolled out. A follow-up
-- migration in a later release drops it.

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
