SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Access path for the corpus status's per-court breakdown: the newest row of
-- one court, and the rows of that court touched since the window opened.
-- `(country, court, decision_date, id)` answers neither, being ordered by the
-- decision's own date, so each read would walk every index entry of the court
-- and fall back to the heap. Led by country and court, both are index ranges
-- the walk enters at the right place; `created_at` rides along as a trailing
-- key so the "added recently" counts stay index-only.
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

-- Retry cleanup for this migration's own index: a cancelled concurrent build
-- can leave an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_country_court_updated_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_country_court_updated_idx"
  ON "case_law_decisions" ("country", "court", "updated_at" DESC, "created_at");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
