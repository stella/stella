SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Actor-filter requests are always scoped to one organization and workspace,
-- and only user performers have a selectable actor ID. Keep the legacy
-- fallback expression in the index so old user_id-only audit rows use the same
-- access path as provenance-aware rows.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY outside a transaction block.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - this retry cleanup
-- targets only this migration's index; a cancelled concurrent build can leave
-- an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_org_workspace_user_actor_created_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "audit_logs_org_workspace_user_actor_created_id_idx"
  ON "audit_logs" (
    "organization_id",
    "workspace_id",
    (coalesce("performer_id", "user_id")),
    "created_at",
    "id"
  )
  WHERE "performer_type" = 'user';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
