SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Split the migrator transaction for a non-blocking document signal index.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - removes only this migration's own interrupted index build before replay
DROP INDEX CONCURRENTLY IF EXISTS "entities_ws_editor_updated_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "entities_ws_editor_updated_idx" ON "entities" ("workspace_id", "last_edited_by", "updated_at") WHERE "kind" = 'document';
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
