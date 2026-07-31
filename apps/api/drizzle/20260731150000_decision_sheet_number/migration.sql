SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Sheet number within the court file (číslo listu), which some sources append
-- to the docket as `11 C 153/2025-28`. It identifies where a document sits in
-- the file, not which case it belongs to, and no citation names it, so keeping
-- it on `case_number` fragments one case into a reference per sheet and
-- matches nothing.
--
-- Values are not backfilled here: rewriting `case_number` on existing rows is
-- more than one in-transaction UPDATE can finish within statement_timeout, and
-- it is only safe once a row's identity no longer rests on the case number.
-- src/scripts/normalize-case-numbers.ts does it in batches and skips any row
-- whose `source_document_id` is still NULL.
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "sheet_number" varchar(32);--> statement-breakpoint
