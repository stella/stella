SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- When the API first wrote a run's `run.start` to one of its computer's
-- sockets. A run never written to a socket ends after the short unaccepted
-- window; one that was may already be running on a computer that lost its
-- connection before its acceptance arrived, so it keeps the recovery window
-- and is offered again when the computer is back. A nullable column with no
-- default: adding it rewrites nothing.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz;
