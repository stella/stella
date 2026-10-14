SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Split the migrator transaction for a non-blocking document signal index.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- Rebuild only this migration's interrupted index before replay.
DROP INDEX CONCURRENTLY IF EXISTS "entities_ws_editor_updated_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "entities_ws_editor_updated_idx" ON "entities" ("workspace_id", "last_edited_by", "updated_at") WHERE "kind" = 'document';
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
