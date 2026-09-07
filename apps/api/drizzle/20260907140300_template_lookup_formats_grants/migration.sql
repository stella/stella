SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "template_lookup_formats" TO "stella";
