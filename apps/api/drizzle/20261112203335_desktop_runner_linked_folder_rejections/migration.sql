SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A desktop now refuses a run in a folder the member linked on it when the
-- link is gone, the folder's volume is not mounted, the folder moved, it holds
-- what runs rely on, or it cannot be read, which
-- DESKTOP_RUNNER_STORED_REJECT_REASONS lists. Dropped by name and re-added in
-- one statement, so no running API task observes the column unconstrained. It
-- only widens the accepted set, so every stored row already satisfies it;
-- desktop_runner_runs holds few rows (ended runs are pruned), so validating it
-- here reads them within the timeouts above.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with the five folder reasons added in the same statement; no row data is touched. Rollback is the same statement without them, which is safe once no row holds those values.
ALTER TABLE "desktop_runner_runs"
  DROP CONSTRAINT IF EXISTS "desktop_runner_runs_reject_reason_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_reject_reason_check"
  CHECK (("state" = 'rejected') = ("reject_reason" IS NOT NULL) AND ("reject_reason" IS NULL OR "reject_reason" IN ('harness_not_installed','harness_needs_login','harness_limited','harness_unsupported','harness_unavailable','harness_version_unavailable','model_unavailable','policy_unsupported','at_capacity','run_too_large','unknown_run','folder_busy','folder_unlinked','folder_offline','folder_moved','folder_protected','folder_unreadable')));
