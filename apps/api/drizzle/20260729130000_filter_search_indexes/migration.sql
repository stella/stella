SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Filter-only tenant search reads newest rows by semantic update time. Build
-- matching organization-leading keyset indexes without blocking document,
-- matter, or contact writes on existing deployments.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for concurrent builds,
-- then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - each drop targets
-- only this migration's own index name. A cancelled concurrent build can leave
-- an INVALID index that IF NOT EXISTS would otherwise retain.
DROP INDEX CONCURRENTLY IF EXISTS "search_documents_org_updated_id_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - same retry cleanup
-- reasoning as the entity-search index above, for the matter projection.
DROP INDEX CONCURRENTLY IF EXISTS "workspace_search_docs_org_updated_id_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - same retry cleanup
-- reasoning as the entity-search index above, for the contact projection.
DROP INDEX CONCURRENTLY IF EXISTS "contact_search_docs_org_updated_id_idx";
--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "search_documents_org_updated_id_idx"
  ON "search_documents" ("organization_id", "updated_at" DESC, "entity_id" DESC);
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "workspace_search_docs_org_updated_id_idx"
  ON "workspace_search_documents" ("organization_id", "updated_at" DESC, "workspace_id" DESC);
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "contact_search_docs_org_updated_id_idx"
  ON "contact_search_documents" ("organization_id", "updated_at" DESC, "contact_id" DESC);
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
