SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "folio_collab_rooms"
  VALIDATE CONSTRAINT "folio_collab_rooms_snapshot_revision_check";--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  VALIDATE CONSTRAINT "folio_collab_rooms_snapshot_revision_seed_check";
