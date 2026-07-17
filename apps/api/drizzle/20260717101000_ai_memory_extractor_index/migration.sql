SET lock_timeout = '1s';--> statement-breakpoint
-- The compactions table is high-volume. Keep its index in a retry-safe,
-- index-only migration and remove the five-second statement timeout before
-- leaving Drizzle's transaction wrapper.
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - this only removes a possibly INVALID index left by an interrupted concurrent build; the following statement recreates it before the migration completes.
DROP INDEX CONCURRENTLY IF EXISTS "chat_thread_compactions_memory_unmined_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_thread_compactions_memory_unmined_idx" ON "chat_thread_compactions" ("memory_extraction_attempted_at", "created_at") WHERE memory_extracted_at IS NULL AND status = 'active';
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - this only removes a possibly INVALID index left by an interrupted concurrent build; the following statement recreates it before any composite foreign key is installed.
DROP INDEX CONCURRENTLY IF EXISTS "workspaces_id_org_unq";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workspaces_id_org_unq" ON "workspaces" ("id", "organization_id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
