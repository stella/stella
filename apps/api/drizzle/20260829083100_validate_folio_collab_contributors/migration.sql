SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "entity_versions"
  VALIDATE CONSTRAINT "entity_versions_collaboration_contributors_check";
