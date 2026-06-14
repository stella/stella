SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "playbook_source_id" uuid;
