SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_provider_webhook_events" ADD COLUMN "replay_audit" jsonb;
