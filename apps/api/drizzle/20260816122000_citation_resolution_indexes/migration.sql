SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The indexes the new resolution shape needs. Last of the three, so the
-- burn-down index is built over the statuses 20260816121000 already settled
-- rather than over every citation.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent
-- builds, then restore and reopen a transaction for Drizzle's migration row.
-- Same shape as 20260730180000_citation_key.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- The burn-down index, repointed at the predicate that can actually empty and
-- keyed on the walk's axis. Both id families are uuidv7, so walking citations
-- in citing-decision order reads the decisions heap in insertion order rather
-- than at random; "id" closes the pair so the keyset is a strict total order.
--
-- The predicate must match `unsettledCitationSql` in
-- handlers/case-law/citation-resolution-status.ts exactly, because that is what
-- the walk's WHERE clause is built from: a partial index whose predicate is
-- narrower than its query is not a slower index, it is an unused one, and
-- nothing about the query would look wrong. The second arm covers a `resolved`
-- row whose target was deleted — `cited_decision_id` is ON DELETE SET NULL, so
-- that row claims a target it no longer has and is nobody's work until the walk
-- treats it as unsettled.
-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before recreating it. A cancelled concurrent
-- build leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_pending_walk_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_pending_walk_idx" ON "case_law_citations" ("citing_decision_id","id") WHERE ("resolution_status" = 'pending' OR ("resolution_status" = 'resolved' AND "cited_decision_id" IS NULL)) AND "citation_key" IS NOT NULL;--> statement-breakpoint

-- The reverse direction: a decision whose key changes asks which citations
-- that key can now answer differently. Without it that question is a scan of
-- every citation, on the ingestion path, once per stored decision.
--
-- Both negative outcomes, matching `citationReopenableByKeySql`. `unmatched`
-- is the obvious one; `ambiguous` is the one that is easy to miss, because a
-- candidate changing its case number, jurisdiction or date can leave the
-- remaining one unique, and an ambiguous row carries no cited_decision_id, so
-- the key is the only handle anything has on it.
-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_reopenable_key_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_reopenable_key_idx" ON "case_law_citations" ("citation_key") WHERE "resolution_status" IN ('unmatched', 'ambiguous');--> statement-breakpoint

-- The candidate lookup answered entirely from the index. The key finds the
-- candidates, jurisdiction and date decide between them, and the id is what
-- gets written; without the trailing columns each candidate costs a heap fetch
-- into a six-million-row table at a random offset.
-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_citation_candidate_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_citation_candidate_idx" ON "case_law_decisions" ("citation_key","country","decision_date","id") WHERE "citation_key" IS NOT NULL;--> statement-breakpoint

-- Superseded: its predicate is the pending one's old spelling, and the walk it
-- served no longer exists.
-- stella-migration-safety: reviewed destructive-change - replaced above by
-- case_law_citations_pending_walk_idx, which covers the same scan with a
-- predicate that empties as citations settle.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_unresolved_key_idx";--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
