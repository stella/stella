SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The compatibility release taught every replica both cursor protocols. The
-- old full-title index must be absent while the column is widened: PostgreSQL
-- otherwise rebuilds the dependent B-tree inside ALTER TABLE, and unbounded
-- titles would still fail its tuple-size limit.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - the follow-up query
-- uses the bounded expression index created below; legacy cursors remain a
-- correct, temporary unindexed compatibility path.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_id_idx";--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - the same trigram
-- index is recreated concurrently after the metadata-only type change.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_title_trgm_idx";--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
-- Keep lock acquisition bounded, but do not interrupt metadata-only catalog
-- work after PostgreSQL grants the lock. No title-dependent B-tree exists in
-- this block, so PostgreSQL does not rebuild one under ACCESS EXCLUSIVE.
-- stella-migration-safety: metadata-only-type-change
SET statement_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening
-- varchar(1024) to text uses the same storage representation and loses no
-- values. Rollback may narrow only after proving every stored title fits.
ALTER TABLE "legislation_documents"
  ALTER COLUMN "title" SET DATA TYPE text;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Rebuild the bounded access path outside the migration transaction. Retry
-- cleanup removes only an INVALID or interrupted copy with this new name.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup targets
-- only this migration's replacement index.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_title_sort_id_idx";--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup targets
-- only this migration's replacement trigram index.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_title_trgm_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_country_title_sort_id_idx"
  ON "legislation_documents" ("country", left("title", 52), "id");--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_title_trgm_idx"
  ON "legislation_documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
