SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260901190000_case_law_decisions_country_court_date_idx.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Drops only this migration's own index by name before recreating it. A
-- cancelled concurrent build leaves an INVALID index behind, and IF NOT
-- EXISTS would then skip recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_country_date_idx";
--> statement-breakpoint
-- The public browse walk with no court chosen, which is how the browse page
-- opens: country is the one filter the handler always applies, court only
-- when the chip is set. `case_law_decisions_country_court_date_idx` carries
-- this sort key behind `court`, so within a country it orders by court first
-- and cannot serve this ORDER BY; the walk falls back to the corpus-wide date
-- index and skips every other country's rows, which for a country holding a
-- small share of the corpus is most of it. The expression, direction and
-- tiebreaker are the handler's own sort key, so the walk is an index range
-- read backwards.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_country_date_idx"
  ON "case_law_decisions" ("country", coalesce("decision_date", '-infinity'::date), "id");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
