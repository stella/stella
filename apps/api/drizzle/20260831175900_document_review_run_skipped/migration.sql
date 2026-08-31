SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- What the proposal pass read and deliberately did not turn into a position,
-- pinned on the run beside the positions it did propose. Without it the count
-- a reviewer saw while confirming ("Not compared: 7") disappears the moment the
-- run starts, and the results read as if the checklist had covered the whole
-- document.
--
-- The default is a constant, so the rewrite is metadata-only and no existing
-- row is read.
ALTER TABLE "document_review_runs"
  ADD COLUMN "skipped" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- A list, and no longer than the proposal pass will report (REVIEW_SKIPPED_MAX
-- in lib/document-review/contract.ts). The array arrives element by element
-- from the wire and Drizzle's `$type` is compile-time only, so the column
-- states the rule itself.
--
-- Added validating rather than NOT VALID + VALIDATE: every row holds the empty
-- default the column was just created with, so the scan has nothing to read,
-- and the migrator wraps a migration in one transaction, so the split form
-- would hold its locks to commit anyway.
ALTER TABLE "document_review_runs"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "document_review_runs_skipped_shape_check"
  CHECK (
    jsonb_typeof("skipped") = 'array' AND jsonb_array_length("skipped") <= 40
  );
