SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN IF NOT EXISTS "notification_status" text DEFAULT 'suppressed' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN IF NOT EXISTS "notification_lang" varchar(10) DEFAULT 'en' NOT NULL;--> statement-breakpoint
-- squawk-ignore prefer-timestamp-tz -- the later timestamptz_everywhere migration upgrades this historical intermediate type
ALTER TABLE "report_exports" ADD COLUMN IF NOT EXISTS "notification_attempted_at" timestamp;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = '0';
--> statement-breakpoint
-- The runner validates this index and concurrently repairs an INVALID build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "report_exports_pending_notification_idx" ON "report_exports" USING btree ("created_at","id") WHERE "notification_status" = 'pending' AND "status" IN ('completed', 'failed');
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
