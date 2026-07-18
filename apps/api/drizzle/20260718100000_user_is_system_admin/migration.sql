SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_system_admin" boolean DEFAULT false NOT NULL;
