SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The active-and-archived memory picker walks accessible, non-deleting
-- matters newest-first. Build its organization-leading keyset index without
-- blocking workspace reads or writes on existing deployments.
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
DROP INDEX CONCURRENTLY IF EXISTS "workspaces_org_activity_id_non_deleting_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "workspaces_org_activity_id_non_deleting_idx"
  ON "workspaces" ("organization_id", "last_activity_at" DESC, "id" DESC)
  WHERE "status" <> 'deleting';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
