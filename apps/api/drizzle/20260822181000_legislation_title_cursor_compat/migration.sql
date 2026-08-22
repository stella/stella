SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires concurrent index operations outside a transaction block.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup targets
-- only this migration's replacement index; a cancelled concurrent build can
-- leave an INVALID index that blocks recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_sort_id_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_country_title_sort_id_idx"
  ON "legislation_documents" ("country", left("title", 52), "id");--> statement-breakpoint

-- A later release widens the title after every replica understands the
-- bounded cursor protocol. Remove the full-title index now so that cutover
-- cannot expose a text column behind a B-tree that rejects large values.
-- stella-migration-safety: reviewed destructive-change - the replacement
-- index above is installed first; the compatibility query can sort its small
-- transition result without the legacy index.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_id_idx";--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
