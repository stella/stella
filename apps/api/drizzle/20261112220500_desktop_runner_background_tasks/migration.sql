SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- How many tasks the harness process a finished run left behind keeps
-- running in the background on its computer, as the computer last reported
-- (`run.background`), while the run's chat waits for its next turn. 0 when
-- none. A constant default adds the column in the catalog without rewriting
-- a row.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "background_tasks" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- The check only constrains the new column, which every existing row holds
-- as 0; it is added NOT VALID and validated online, so no scan runs under
-- this migration's lock.
ALTER TABLE "desktop_runner_runs" ADD CONSTRAINT "desktop_runner_runs_background_tasks_check"
  CHECK ("background_tasks" BETWEEN 0 AND 1000) NOT VALID;--> statement-breakpoint
