SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "entity_views" TO "stella";
