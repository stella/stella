SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The keys a phone's Lock Screen buttons pause and resume its person's timers
-- with, kept as their SHA-256 only: the current one, the one before it (which
-- works until it expires, for a phone that missed the newer one), and whether
-- the phone said it holds one. Columns on a small table, nullable or with a
-- constant default; nothing reads them until this release.
ALTER TABLE "timer_activity_devices" ADD COLUMN "action_key_hash" text;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" ADD COLUMN "action_key_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" ADD COLUMN "previous_action_key_hash" text;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" ADD COLUMN "previous_action_key_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "timer_activity_devices" ADD COLUMN "action_key_held" boolean DEFAULT false NOT NULL;
