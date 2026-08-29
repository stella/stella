SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "folio_collab_rooms"
  ADD COLUMN "yjs_snapshot_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_snapshot_revision_check"
  CHECK ("yjs_snapshot_revision" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_snapshot_revision_seed_check"
  CHECK (
    ("seed_state" IN ('empty', 'claimed') AND "yjs_snapshot_revision" = 0)
    OR ("seed_state" = 'seeded' AND "yjs_snapshot_revision" > 0)
  ) NOT VALID;
