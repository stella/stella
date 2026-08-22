SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Keep lock acquisition bounded, but do not interrupt metadata-only catalog work after PostgreSQL grants the lock.
-- stella-migration-safety: metadata-only-type-change
SET statement_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening varchar(1024) -> text is a metadata-only catalog change with no table rewrite or data loss; official legislation titles have no fixed maximum length. Rollback is to restore varchar(1024) only after proving every stored title fits.
ALTER TABLE "legislation_documents" ALTER COLUMN "title" SET DATA TYPE text;--> statement-breakpoint
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
  ON "legislation_documents" ("country", left("title", 64), "id");--> statement-breakpoint

-- The full unbounded title cannot remain in a B-tree: PostgreSQL rejects an
-- oversized index tuple before the row can be stored.
-- stella-migration-safety: reviewed destructive-change - the replacement
-- index above serves the same list query with its bounded title expression.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_id_idx";--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
