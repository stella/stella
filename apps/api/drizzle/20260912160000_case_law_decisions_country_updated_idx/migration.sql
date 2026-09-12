SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Access path for the corpus status's "when did this country's case law last
-- change": the newest row of one country. Walking the global
-- (updated_at, id) index from the top and filtering on country reads every
-- newer row of every other country first, so a large ingestion batch elsewhere
-- turns the single-row lookup into a scan of that batch. Led by country, the
-- walk stops at the first row.
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
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_country_updated_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_country_updated_idx"
  ON "case_law_decisions" ("country", "updated_at" DESC, "id" DESC);
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
