-- requires: 20260827200000_folio_collab_rooms
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- A collaboration checkpoint is the stored document materialized again, so it
-- follows the document limit, now 200 MiB (209715200 bytes). Widening only:
-- every existing row already passes. The check is replaced in one
-- transaction, so no running task ever sees the table without it; it is
-- installed NOT VALID and validated online after deployment
-- (folio-collab-checkpoint-constraint-validation.ts). Every stage is safe to
-- run again.
-- stella-migration-safety: reviewed drop-constraint - the constraint is re-added NOT VALID in the same transaction with a higher bound, so no running task ever sees the table without it, and a failure rolls both statements back together.
ALTER TABLE "folio_collab_rooms"
  DROP CONSTRAINT IF EXISTS "folio_collab_rooms_checkpoint_size_check";
--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_checkpoint_size_check"
  CHECK (
    "docx_checkpoint_size_bytes" IS NULL OR ("docx_checkpoint_size_bytes" >= 0 AND "docx_checkpoint_size_bytes" <= 209715200)
  ) NOT VALID;
