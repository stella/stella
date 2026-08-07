SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "guide_progress" text;--> statement-breakpoint
GRANT SELECT (guide_progress) ON TABLE "user" TO stella;
