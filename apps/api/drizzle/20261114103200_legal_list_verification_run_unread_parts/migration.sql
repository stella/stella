SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Text a completed verification run could not read, because an extraction
-- call kept failing after its retries, so the run can say it was not read
-- whole. Edges only (block id and offset), never text. Runs completed before
-- read everything they completed with, so they carry none.
--
-- The default is a constant, so the rewrite is metadata-only and no existing
-- row is read.
ALTER TABLE "legal_list_verification_runs"
  ADD COLUMN "unread_parts" jsonb DEFAULT '[]'::jsonb NOT NULL;
