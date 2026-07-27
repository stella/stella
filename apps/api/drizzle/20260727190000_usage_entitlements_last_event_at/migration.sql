SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_entitlements" ADD COLUMN "hosted_last_event_at" timestamp with time zone;
