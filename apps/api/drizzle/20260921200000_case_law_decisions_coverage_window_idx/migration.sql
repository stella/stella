SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Access paths for the coverage page's two windowed counts: a source's
-- decisions published in the last week, and a court's rows touched since that
-- window opened. Both ride an index range today and then fetch every row in
-- it to evaluate the publication gate, which reads `metadata`: a JSONB blob
-- that is TOASTed on most rows, so each row in the window costs random reads
-- of its own. A week of one busy source is over a hundred thousand rows, and
-- the read overruns the statement budget the page gives it; the page then
-- reports the week as unknown.
--
-- Partial on the gate, the same way `case_law_decisions_search_candidate_idx`
-- is: the predicate costs nothing per row, and the count becomes an
-- index-only scan of the window. The text matches `storedObservationHasDetail`
-- exactly, which is what lets the planner prove the read's own predicate
-- implies it. The unpartitioned siblings stay: the ingestion cursor walks
-- listing-only rows too, and the status read of one court's newest row is
-- served by either.
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

-- Retry cleanup for this migration's own indexes: a cancelled concurrent build
-- can leave an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_arrivals_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_source_arrivals_idx"
  ON "case_law_decisions" ("source_id", "created_at")
  WHERE jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') is distinct from 'true';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_court_activity_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_court_activity_idx"
  ON "case_law_decisions" ("country", "court", "updated_at" DESC, "created_at")
  WHERE jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') is distinct from 'true';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
