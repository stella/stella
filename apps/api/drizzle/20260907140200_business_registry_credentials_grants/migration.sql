SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "business_registry_credentials" TO "stella";
