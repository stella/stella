-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction so existing exports remain writable. Drop a
-- possible invalid index left by an interrupted build before retrying.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "report_exports_workspace_requester_created_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON "report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
