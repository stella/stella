SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "user_shortcuts" text;--> statement-breakpoint
GRANT SELECT (user_shortcuts) ON TABLE "user" TO stella;
