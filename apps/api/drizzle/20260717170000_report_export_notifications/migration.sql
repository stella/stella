SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN IF NOT EXISTS "notification_status" text DEFAULT 'suppressed' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN IF NOT EXISTS "notification_lang" varchar(10) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN IF NOT EXISTS "notification_attempted_at" timestamp;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = '0';
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup drops only this migration's partial reconciliation index before rebuilding it; no table data is removed, and this prevents a cancelled concurrent build from leaving an invalid index that IF NOT EXISTS would silently accept.
DROP INDEX CONCURRENTLY IF EXISTS "report_exports_pending_notification_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "report_exports_pending_notification_idx" ON "report_exports" USING btree ("created_at","id") WHERE "notification_status" = 'pending' AND "status" IN ('completed', 'failed');
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
