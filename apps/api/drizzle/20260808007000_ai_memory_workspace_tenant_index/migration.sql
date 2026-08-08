SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - remove only an INVALID artifact left by an interrupted concurrent build. A valid index may already back the composite unique constraint and must never be dropped.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_class AS index_relation
		INNER JOIN pg_catalog.pg_index AS index_state
			ON index_state.indexrelid = index_relation.oid
		INNER JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = index_relation.relnamespace
		WHERE namespace.nspname = 'public'
			AND index_relation.relname = 'workspaces_id_org_unq'
			AND index_state.indisvalid = false
	) THEN
		DROP INDEX public.workspaces_id_org_unq;
	END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workspaces_id_org_unq" ON "workspaces" ("id", "organization_id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
