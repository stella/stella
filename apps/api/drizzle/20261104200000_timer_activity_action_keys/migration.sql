SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The key a phone's Lock Screen buttons pause and resume its person's timers
-- with, kept as its SHA-256 only, and when it stops working. Nullable columns
-- on a small table; nothing reads them until this release.
ALTER TABLE "timer_activity_devices" ADD COLUMN "action_key_hash" text;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" ADD COLUMN "action_key_expires_at" timestamptz;
