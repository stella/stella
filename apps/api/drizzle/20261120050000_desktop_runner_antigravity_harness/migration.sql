SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- A run may be assigned to Antigravity, the first agent a desktop runs over
-- the Agent Client Protocol. Dropped by name and re-added in one statement,
-- so no running API task observes the column unconstrained. It only widens
-- the accepted set, so every stored row already satisfies it.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `antigravity` added in the same statement; no row data is touched. Rollback is the same statement without it, which is safe once no row holds that value.
ALTER TABLE "desktop_runner_runs"
  DROP CONSTRAINT IF EXISTS "desktop_runner_runs_harness_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_harness_check"
  CHECK ("harness" IN ('codex','claude-code','opencode','antigravity'));
