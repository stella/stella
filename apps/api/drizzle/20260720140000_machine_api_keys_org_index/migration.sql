SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Machine-key lifecycle (list/rotate/revoke) is organization-scoped, not
-- caller-scoped, so every one of those reads filters on the owning organization
-- id. That id lives inside the plugin's `metadata` JSON column, and filtering an
-- unindexed JSON expression is exactly what `/conventions-db` warns against, so
-- the expression gets its own index rather than the filter being pushed into JS.
--
-- This is the tenant boundary for the `apikey` table: the scoped `stella` role
-- is denied the table outright, so these reads run on the owner connection where
-- RLS does not apply and the `WHERE` clause is the only thing separating one
-- organization's credentials from another's. It must stay indexed and it must
-- stay in the query.
--
-- `(metadata::jsonb ->> 'organizationId')` is immutable, so it is indexable.
-- Rows written by this codebase always carry valid JSON metadata; the partial
-- predicate keeps NULL-metadata rows out of the index rather than casting them.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL requires
-- CREATE INDEX CONCURRENTLY to run outside a transaction block. Split the
-- migrator transaction, lift the timeouts for the concurrent builds (which are
-- expected to outlive a 5s statement_timeout and take no lock those timeouts
-- guard), then restore and reopen a transaction for Drizzle's migration row.
-- Same shape as 20260707120000_property_role.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own indexes by name before recreating them below. A cancelled
-- concurrent build leaves an INVALID index behind, and `IF NOT EXISTS` would
-- then skip recreating it — leaving the tenant filter running against an index
-- Postgres will not use. Dropping first and creating without `IF NOT EXISTS`
-- means a retry cannot record the migration while that boundary is unindexed.
DROP INDEX CONCURRENTLY IF EXISTS "apikey_metadata_organization_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "apikey_metadata_organization_id_idx" ON "apikey" (((metadata::jsonb ->> 'organizationId'))) WHERE metadata IS NOT NULL;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - same reasoning as the
-- index above; this one additionally carries the keyset ordering the
-- organization-scoped list paginates on.
DROP INDEX CONCURRENTLY IF EXISTS "apikey_org_keyset_idx";
--> statement-breakpoint
-- Keyset pagination for the organization-scoped list orders by (created_at, id).
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "apikey_org_keyset_idx" ON "apikey" (((metadata::jsonb ->> 'organizationId')), "created_at" DESC, "id" DESC) WHERE metadata IS NOT NULL;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
