SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Citation resolution recorded its outcome in the nullability of
-- "cited_decision_id", which cannot distinguish "not examined yet" from
-- "examined, and no honest link exists". The resolver's scan predicate
-- therefore never emptied: every citation whose key names a decision nobody
-- holds was re-examined on every pass, forever, and the partial index that
-- was meant to burn down stayed the size of that permanent residue.
--
-- The outcome moves to its own column. Four values, because "no candidate"
-- and "more than one candidate" have different repairs: a decision published
-- later fixes the first, a deterministic context cue fixes the second.
ALTER TABLE "case_law_citations"
  ADD COLUMN IF NOT EXISTS "resolution_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "case_law_citations"
  ADD COLUMN IF NOT EXISTS "resolution_attempted_at" timestamptz;--> statement-breakpoint

-- NOT VALID here, VALIDATE after the transaction splits: adding a validating
-- CHECK scans every row while holding ACCESS EXCLUSIVE, which on a table this
-- size is an outage. NOT VALID takes the lock only long enough to record the
-- constraint; the scan then runs under SHARE UPDATE EXCLUSIVE, which concurrent
-- readers and writers do not wait on.
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_resolution_status_values"
  CHECK ("resolution_status" IN ('pending','resolved','unmatched','ambiguous'))
  NOT VALID;--> statement-breakpoint

-- The empty string is not a key, it is the absence of one wearing a value's
-- clothes. Two rows that both failed to canonicalize would carry the same
-- "key" and join each other, drawing an edge between unrelated cases; null
-- already means "no key", so this makes the second spelling unrepresentable.
-- One writer wrote '' where the other wrote NULL, which is exactly the drift
-- a constraint exists to stop.
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_citation_key_non_empty"
  CHECK ("citation_key" <> '')
  NOT VALID;--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "decisions_citation_key_non_empty"
  CHECK ("citation_key" <> '')
  NOT VALID;--> statement-breakpoint

-- Where the standing resolution walk had got to. The walk is correct without
-- it — settled rows leave the pending predicate, so a restart from the
-- beginning loses no work — but the left edge of the burn-down index carries
-- index entries autovacuum has not reclaimed yet, and every restart would
-- re-read them before reaching live work.
CREATE TABLE IF NOT EXISTS "case_law_citation_resolution_progress" (
  "scope" text PRIMARY KEY NOT NULL,
  "cursor_citing_decision_id" uuid,
  "cursor_citation_id" uuid,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Added validating, not NOT VALID + VALIDATE: the table is created empty in
-- this same migration, so the scan is over no rows.
ALTER TABLE "case_law_citation_resolution_progress"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_progress_scope_values"
  CHECK ("scope" IN ('global'));--> statement-breakpoint

-- Half a keyset is not a position: either both columns name where the walk
-- stopped, or neither does and it starts from the beginning.
ALTER TABLE "case_law_citation_resolution_progress"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_progress_cursor_pair"
  CHECK (("cursor_citing_decision_id" IS NULL) = ("cursor_citation_id" IS NULL));--> statement-breakpoint

ALTER TABLE "case_law_citation_resolution_progress"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Same access shape as the coverage ledger and the reconciliation items: the
-- app role reads it for the ingestion status rollup, only ingestion writes it.
CREATE POLICY "case_law_global_access" ON "case_law_citation_resolution_progress" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_citation_resolution_progress" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT ON TABLE "case_law_citation_resolution_progress" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_citation_resolution_progress" TO stella_ingestion;--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block, and
-- the constraint validations below must not hold their locks to commit.
-- Split the migrator transaction, lift the timeouts, then restore and reopen
-- a transaction for Drizzle's migration row. Same shape as
-- 20260730180000_citation_key.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Carry the outcome the old representation did record. A row already linked
-- to a decision was resolved by the previous algorithm; everything else stays
-- pending and is examined once by the new one. Idempotent, so a re-run after
-- an interrupted migration repeats no work.
-- stella-migration-safety: reviewed bulk-backfill - restates the outcome
-- already implied by cited_decision_id; served by the partial cited index and
-- touches no row whose status is already set.
UPDATE "case_law_citations"
   SET "resolution_status" = 'resolved'
 WHERE "cited_decision_id" IS NOT NULL
   AND "resolution_status" = 'pending';--> statement-breakpoint

-- The burn-down index, repointed at the predicate that can actually empty and
-- keyed on the walk's axis. Both id families are uuidv7, so walking citations
-- in citing-decision order reads the decisions heap in insertion order rather
-- than at random; "id" closes the pair so the keyset is a strict total order.
-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before recreating it. A cancelled concurrent
-- build leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_pending_walk_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_pending_walk_idx" ON "case_law_citations" ("citing_decision_id","id") WHERE "resolution_status" = 'pending' AND "citation_key" IS NOT NULL;--> statement-breakpoint

-- The reverse direction: a decision arriving under key K asks which citations
-- gave up on K. Without it that question is a scan of every citation, on the
-- ingestion path, once per stored decision.
-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_unmatched_key_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_unmatched_key_idx" ON "case_law_citations" ("citation_key") WHERE "resolution_status" = 'unmatched';--> statement-breakpoint

-- The candidate lookup answered entirely from the index: the key finds the
-- candidates, jurisdiction and date decide between them, and the id is what
-- gets written. Without the trailing columns each candidate costs a heap fetch
-- into a 6-million-row table at random offsets.
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

-- Repair the sentinel drift before validating it away. One writer stored ''
-- for a text that does not canonicalize where the other stored NULL, so a
-- database that ran the older backfill holds rows the new constraint would
-- reject. NULL is the surviving spelling; '' rows would otherwise have joined
-- each other.
-- stella-migration-safety: reviewed bulk-backfill - rewrites a sentinel that
-- never named a key to the NULL that means the same thing; idempotent, and
-- production holds no such row.
UPDATE "case_law_citations" SET "citation_key" = NULL WHERE "citation_key" = '';--> statement-breakpoint
UPDATE "case_law_decisions" SET "citation_key" = NULL WHERE "citation_key" = '';--> statement-breakpoint

-- The scans the NOT VALID constraints deferred. SHARE UPDATE EXCLUSIVE, so
-- concurrent readers and writers keep running; run here rather than inside the
-- migrator transaction so the lock is released as each finishes.
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_resolution_status_values";--> statement-breakpoint
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_citation_key_non_empty";--> statement-breakpoint
ALTER TABLE "case_law_decisions" VALIDATE CONSTRAINT "decisions_citation_key_non_empty";--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
