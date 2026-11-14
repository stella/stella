SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- When the API first wrote a run's `run.start` to one of its computer's
-- sockets. A run never written to a socket ends after the short unaccepted
-- window; one that was may already be running on a computer that lost its
-- connection before its acceptance arrived, so it keeps the recovery window
-- and is offered again when the computer is back. Nullable, no default: the
-- column is added in the catalog without rewriting a row.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz;--> statement-breakpoint

-- Why the API ended a run as `lost`, where it knows: no computer picked it
-- up, or its computer was linked again under a new device key. Nullable, no
-- default, so no row is rewritten; every existing row holds NULL, so the
-- check below holds for each of them.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "lost_reason" text;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "desktop_runner_runs" ADD CONSTRAINT "desktop_runner_runs_lost_reason_check"
  CHECK (("lost_reason" IS NULL OR "state" = 'lost') AND ("lost_reason" IS NULL OR "lost_reason" IN ('not_reached','computer_relinked')));--> statement-breakpoint

-- A device key a newer key of the same account replaced on an installation
-- is `retired`: never routed to again and never allowed to claim the
-- installation back. Dropped by name and re-added in one statement, so no
-- running API task observes the column unconstrained. It only widens the
-- accepted set, so every stored row already satisfies it; desktop_runners
-- holds a few rows per member, so validating it reads them within the
-- timeouts above.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `retired` added in the same statement; no row data is touched. Rollback is the same statement without it, which is safe once no row holds that value.
ALTER TABLE "desktop_runners"
  DROP CONSTRAINT IF EXISTS "desktop_runners_connection_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runners_connection_check"
  CHECK ("connection" IN ('connected','disconnected','retired'));
