SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "detected_country" text;--> statement-breakpoint
GRANT SELECT (detected_country) ON TABLE "user" TO stella;
