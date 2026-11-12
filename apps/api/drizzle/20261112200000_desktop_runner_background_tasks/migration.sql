SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- How many tasks the harness process a finished run left behind keeps
-- running in the background on its computer, as the computer last reported
-- (`run.background`), while the run's chat waits for its next turn. 0 when
-- none. A constant default adds the column in the catalog without rewriting
-- a row.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "background_tasks" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- Every existing row holds 0, so the check holds for each of them.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "desktop_runner_runs" ADD CONSTRAINT "desktop_runner_runs_background_tasks_check"
  CHECK ("background_tasks" BETWEEN 0 AND 1000);
