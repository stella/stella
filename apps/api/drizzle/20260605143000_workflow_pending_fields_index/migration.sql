-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, build the large-table index without
-- write-blocking locks, then reopen a transaction for Drizzle's migration row.
COMMIT;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "fields_pending_workspace_idx" ON "fields" ("workspace_id") WHERE "content"->>'type' = 'pending';
--> statement-breakpoint
BEGIN;
