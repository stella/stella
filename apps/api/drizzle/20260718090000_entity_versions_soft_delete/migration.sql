SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "entity_versions" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "entity_versions" ADD COLUMN "deleted_by" text;
