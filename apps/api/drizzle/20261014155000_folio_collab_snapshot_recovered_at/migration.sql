SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Recovery from a refused collaboration snapshot resets the room's snapshot
-- revision, so the revision can no longer tell the next seeding client that
-- unsaved changes were discarded. The room records the recovery itself; the
-- next stored snapshot clears it. Nullable with no default: a metadata-only
-- column add on an existing table.
ALTER TABLE "folio_collab_rooms" ADD COLUMN "snapshot_recovered_at" timestamptz;
