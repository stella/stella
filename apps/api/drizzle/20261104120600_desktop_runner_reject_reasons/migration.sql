SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A desktop now refuses a run with `harness_unavailable` (its harness could
-- not be checked) or `run_too_large` (the run cannot be handed to its harness
-- host whole), each of which DESKTOP_RUNNER_STORED_REJECT_REASONS lists. The
-- schema builds this CHECK from that list, so the constraint the database
-- enforces widens in step, or every such refusal fails to store.
--
-- Dropped by name and re-added in one statement, so no running API task
-- observes the column unconstrained, and a second run re-records the same
-- constraint. It only widens the accepted set, so every stored row already
-- satisfies it; desktop_runner_runs holds a handful of rows at most (runner
-- sockets are invitation-only and ended runs are pruned), so validating it
-- here reads those rows within the timeouts above.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `harness_unavailable` and `run_too_large` added in the same statement; no row data is touched. Rollback is the same statement without them, which is safe once no row holds either value.
ALTER TABLE "desktop_runner_runs"
  DROP CONSTRAINT IF EXISTS "desktop_runner_runs_reject_reason_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_reject_reason_check"
  CHECK (("state" = 'rejected') = ("reject_reason" IS NOT NULL) AND ("reject_reason" IS NULL OR "reject_reason" IN ('harness_not_installed','harness_needs_login','harness_limited','harness_unsupported','harness_unavailable','harness_version_unavailable','model_unavailable','policy_unsupported','at_capacity','run_too_large','unknown_run')));
