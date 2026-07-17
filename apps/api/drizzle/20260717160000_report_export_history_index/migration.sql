-- The Bun/Drizzle migrator owns one transaction for the migration SQL and its
-- bookkeeping row. Keep this index build inside that transaction so both are
-- atomic. report_exports is a recently introduced job table; bound lock
-- acquisition and build time to avoid a prolonged write interruption.
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "report_exports_workspace_requester_created_idx" ON "report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id");
--> statement-breakpoint
