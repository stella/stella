SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "rollback_token" text;
