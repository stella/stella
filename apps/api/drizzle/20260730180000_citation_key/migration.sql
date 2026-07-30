SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Citation resolution matches a citation's text against a decision's case
-- number. Both sides normalize to the same canonical key (bareCitationKey),
-- so persisting that key on each side turns resolution into an indexed
-- equality join instead of an in-memory scan of every decision.
--
-- Nullable: a citation whose text carries no recognizable case number, and a
-- decision whose case number does not canonicalize, both stay unresolvable
-- rather than matching on an empty string.
ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "citation_key" varchar(128);--> statement-breakpoint
ALTER TABLE "case_law_citations" ADD COLUMN IF NOT EXISTS "citation_key" varchar(128);--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent
-- builds, then restore and reopen a transaction for Drizzle's migration row.
-- Same shape as 20260729010000_corpus_index_pending_partial_idx.
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
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_citation_key_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_citation_key_idx" ON "case_law_decisions" ("citation_key") WHERE "citation_key" IS NOT NULL;--> statement-breakpoint

-- The resolver scans unresolved citations that already carry a key, so the
-- index covers exactly that arm and shrinks as citations resolve.
-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_unresolved_key_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_unresolved_key_idx" ON "case_law_citations" ("citation_key") WHERE "cited_decision_id" IS NULL AND "citation_key" IS NOT NULL;--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
