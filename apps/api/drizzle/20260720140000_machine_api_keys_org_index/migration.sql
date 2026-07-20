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
CREATE INDEX "apikey_metadata_organization_id_idx" ON "apikey" (((metadata::jsonb ->> 'organizationId'))) WHERE metadata IS NOT NULL;--> statement-breakpoint

-- Keyset pagination for the organization-scoped list orders by (created_at, id).
CREATE INDEX "apikey_org_keyset_idx" ON "apikey" (((metadata::jsonb ->> 'organizationId')), "created_at" DESC, "id" DESC) WHERE metadata IS NOT NULL;
