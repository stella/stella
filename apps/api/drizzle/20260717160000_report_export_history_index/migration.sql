-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction so existing exports remain writable. Drop a
-- possible invalid index left by an interrupted build before retrying.
-- stella-migration-safety: reviewed destructive-change - this migration only drops its own new index name before rebuilding it online; an interrupted concurrent build may leave that index invalid, and rerunning this same migration restores it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "report_exports_workspace_requester_created_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "report_exports_workspace_requester_created_idx" ON "report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
