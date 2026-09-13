SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "folio_collab_rooms_workspace_source_version_idx"
  ON "folio_collab_rooms" ("workspace_id", "source_version_id");--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "folio_collab_rooms_workspace_source_version_idx";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

ALTER TABLE "folio_collab_rooms"
  VALIDATE CONSTRAINT "folio_collab_rooms_source_version_entity_workspace_fk";
