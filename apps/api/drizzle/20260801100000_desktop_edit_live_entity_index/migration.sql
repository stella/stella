SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The table/window entity read selects the oldest live session per entity.
-- Build its tenant-leading partial index without blocking desktop editing on
-- existing deployments. Drizzle wraps migrations in a transaction, but
-- PostgreSQL requires CREATE INDEX CONCURRENTLY outside one.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup only;
-- a cancelled concurrent build can leave an INVALID index with this name.
DROP INDEX CONCURRENTLY IF EXISTS "desktop_edit_sessions_live_entity_created_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "desktop_edit_sessions_live_entity_created_id_idx"
  ON "desktop_edit_sessions" ("workspace_id", "entity_id", "created_at", "id")
  WHERE "status" = 'open';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
