SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- What the harness processes runs left behind keep running in the background
-- on the computer, by run id, as the computer reported them over its current
-- socket (`run.background`), while each run's chat waits for its next turn.
-- A run with none has no entry; a new socket starts from none. A constant
-- default adds the column in the catalog without rewriting a row.
ALTER TABLE "desktop_runners" ADD COLUMN IF NOT EXISTS "background_tasks" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
