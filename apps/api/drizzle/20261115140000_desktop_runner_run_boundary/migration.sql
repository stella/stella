SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Where each run's completed turn ended in its harness session (a Codex turn
-- id, a Claude Code transcript entry), so a later run on the same computer can
-- continue that session from there as a new one after an edit or a
-- regeneration. Nullable, no default: added in the catalog without rewriting a
-- row, and a run that finished before it names none.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "harness_boundary" varchar(256);--> statement-breakpoint
-- Only a completed run with a session names a boundary. NOT VALID: no stored
-- row holds one yet, and new rows are checked from here on.
ALTER TABLE "desktop_runner_runs" ADD CONSTRAINT "desktop_runner_runs_harness_boundary_check" CHECK ("harness_boundary" IS NULL OR ("state" = 'finished' AND "outcome" = 'completed' AND "harness_session_id" IS NOT NULL)) NOT VALID;
