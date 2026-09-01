SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260901130000_legislation_title_fold.
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
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_country_court_date_idx";
--> statement-breakpoint
-- The public browse walk scoped to one court (the filter chip, and the
-- newest-decisions shelf's per-court slices) reads newest first and stops at
-- the page. Without a court-leading index that walk scans the corpus-wide
-- date index and skips every other court's rows, which for a small court is
-- most of the corpus. The expression, direction and tiebreaker are the
-- handler's own sort key, so the walk is an index range read backwards.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_country_court_date_idx"
  ON "case_law_decisions" ("country", "court", coalesce("decision_date", '-infinity'::date), "id");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
