SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The byte budget the index below needs. `court`, `language_group_key` and
-- `decision_type` are `varchar(n)`, which bounds characters; a B-tree tuple is
-- bounded in bytes (2704). At the declared character limits, three-byte text
-- builds a 3456-byte row the index refuses, and the insert fails. The longest
-- court name in the corpus is 64 bytes and a language group key is an ECLI or
-- `<source uuid>:<case number>`, so the budget is far above anything stored
-- today; it exists so the index cannot be broken by a future publisher. The
-- remaining columns and the tuple header measure 80 bytes, so 2000 caps an
-- index row near 2080.
--
-- NOT VALID here, VALIDATE below: adding a validating CHECK scans every row
-- while holding ACCESS EXCLUSIVE. NOT VALID takes the lock only long enough to
-- record the constraint, which then applies to every later INSERT and UPDATE.
-- Dropped first so the file is re-runnable: the ADD commits before the
-- VALIDATE, and a failed VALIDATE would otherwise leave a second run failing
-- on a constraint that already exists.
-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "case_law_decisions"
  DROP CONSTRAINT IF EXISTS "case_law_decisions_search_candidate_row_bound";--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "case_law_decisions_search_candidate_row_bound"
  CHECK (
    octet_length("court")
    + coalesce(octet_length("language_group_key"), 0)
    + coalesce(octet_length("decision_type"), 0)
    <= 2000
  ) NOT VALID;--> statement-breakpoint

-- Access path for the case-law search's candidate read: a few hundred ids the
-- engine ranked, read for the five columns the blend needs. The primary key
-- answers the lookup and then fetches every one of those rows from a heap no
-- instance of this size can cache, so a cold request pays a random read per
-- candidate. Carrying the request's filters and the blend's columns as
-- trailing keys turns the same lookup into an index-only scan.
--
-- Partial on the publication gate: that gate reads `metadata`, a JSONB blob no
-- index can carry as a key, and as a predicate it costs nothing per row. The
-- text matches `storedObservationHasDetail` exactly, which is what lets the
-- planner prove the read's own predicate implies it.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent
-- build, then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Validated before the index is built, not after: the scan takes only SHARE
-- UPDATE EXCLUSIVE, so writers keep running, and a row over the budget stops
-- the release here in one table scan instead of failing the concurrent build
-- that follows it.
-- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID constraint added above, outside the additive DDL transaction so its scan does not retain earlier locks.
ALTER TABLE "case_law_decisions"
  VALIDATE CONSTRAINT "case_law_decisions_search_candidate_row_bound";
--> statement-breakpoint

-- Retry cleanup for this migration's own index: a cancelled concurrent build
-- can leave an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_search_candidate_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_search_candidate_idx"
  ON "case_law_decisions" ("id", "country", "source_id", "court", "decision_date", "decision_type", "language", "citation_authority", "language_group_key")
  WHERE jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') is distinct from 'true';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
