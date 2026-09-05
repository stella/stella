SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Why a succeeded index-job row was written, kept apart from the failure it
-- is not. `error_message` is read as the failure of the row it sits on, so a
-- withdrawal filing its reason there reads as an operation that failed. The
-- reason moves to `detail`, and `error_message` keeps its one meaning.
--
-- Nullable with no default: existing rows are untouched and the table takes
-- only a catalog change. Same width as `error_message` in both tables, so a
-- reason is bounded the same way whichever column a reader came for.
-- Rollback drops the column; nothing reads it before this deploys.
ALTER TABLE "case_law_index_jobs"
  ADD COLUMN IF NOT EXISTS "detail" varchar(2048);--> statement-breakpoint

-- The trail is one shape across both families, so both tables move together.
ALTER TABLE "legislation_index_jobs"
  ADD COLUMN IF NOT EXISTS "detail" varchar(2048);
