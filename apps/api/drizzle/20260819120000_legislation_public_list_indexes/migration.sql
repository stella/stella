SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Access paths for the public statute list. Without them the two shapes the
-- route issues both degrade into a full jurisdiction scan on an
-- unauthenticated path: the ordered page has to sort every row of the country
-- before it can take the limit, and the substring filter has no index at all.
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

-- The list's keyset in its own order: the country filter seeks, the title/id
-- pair is both the sort and the cursor, so a page is a range scan that stops
-- at the limit.
-- stella-migration-safety: reviewed destructive-change - this retry cleanup
-- targets only this migration's index; a cancelled concurrent build can leave
-- an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_country_title_id_idx"
  ON "legislation_documents" ("country", "title", "id");
--> statement-breakpoint

-- The search filter matches anywhere in the title or the identifier, which a
-- btree cannot answer. Trigram indexes are what make a leading-wildcard
-- ILIKE a lookup rather than a scan.
-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_title_trgm_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_title_trgm_idx"
  ON "legislation_documents" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - same reasoning.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_eli_trgm_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_eli_trgm_idx"
  ON "legislation_documents" USING gin ("eli" gin_trgm_ops);
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
