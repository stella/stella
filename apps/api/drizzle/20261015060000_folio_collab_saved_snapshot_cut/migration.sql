-- requires: 20260829130000_folio_collab_snapshot_revision
-- requires: 20260829083000_folio_collab_publications
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Nullable, default-free snapshot cuts preserve unknown historical state without
-- reading or rewriting stored snapshots during deployment.
ALTER TABLE "folio_collab_rooms"
  ADD COLUMN "saved_snapshot_cut" jsonb,
  ADD COLUMN "docx_checkpoint_snapshot_sha256_hex" varchar(64);--> statement-breakpoint
ALTER TABLE "folio_collab_publications" ADD COLUMN "snapshot_sha256_hex" varchar(64);

--> statement-breakpoint
-- The seed remains claimed until both its immutable receipt and durable
-- snapshot exist; the stored snapshot may arrive before the receipt.
-- stella-migration-safety: reviewed drop-constraint - Replaces both lifecycle checks atomically with checks that retain existing valid states and admit the pending seed receipt.
ALTER TABLE "folio_collab_rooms"
  DROP CONSTRAINT "folio_collab_rooms_snapshot_revision_seed_check",
  DROP CONSTRAINT "folio_collab_rooms_seed_fields_check",
  ADD CONSTRAINT "folio_collab_rooms_snapshot_revision_seed_check" CHECK (
    ("seed_state" IN ('empty', 'claimed') AND "yjs_snapshot_revision" = 0)
    OR ("seed_state" IN ('claimed', 'seeded') AND "yjs_snapshot_revision" > 0)
  ) NOT VALID,
  ADD CONSTRAINT "folio_collab_rooms_seed_fields_check" CHECK (
    ("seed_state" = 'empty' AND "seed_claimed_by" IS NULL AND "seed_claimed_at" IS NULL AND "seeded_at" IS NULL AND "yjs_snapshot_size_bytes" IS NULL AND "yjs_snapshot_updated_at" IS NULL)
    OR ("seed_state" = 'claimed' AND "seed_claimed_by" IS NOT NULL AND "seed_claimed_at" IS NOT NULL AND "seeded_at" IS NULL AND (
      ("yjs_snapshot_revision" = 0 AND "yjs_snapshot_size_bytes" IS NULL AND "yjs_snapshot_updated_at" IS NULL)
      OR ("yjs_snapshot_revision" > 0 AND "yjs_snapshot_size_bytes" IS NOT NULL AND "yjs_snapshot_updated_at" IS NOT NULL)
    ))
    OR ("seed_state" = 'seeded' AND "seed_claimed_at" IS NOT NULL AND "seeded_at" IS NOT NULL AND "yjs_snapshot_size_bytes" IS NOT NULL AND "yjs_snapshot_updated_at" IS NOT NULL)
  ) NOT VALID;
