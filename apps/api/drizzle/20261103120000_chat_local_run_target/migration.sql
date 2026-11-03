SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Where a thread's turns run: null keeps stella's own model path, otherwise
-- "<harness>::<model>" names a coding-agent harness on the member's computer.
-- Nullable with no default, so adding it rewrites no row. The value is
-- checked when it is written and again when a send reads it.
ALTER TABLE "chat_threads"
  ADD COLUMN IF NOT EXISTS "chat_run_target" varchar(256);--> statement-breakpoint

-- A run started for a chat turn names its thread, and how far the turn has
-- read its messages, so a turn resumed after an approval continues the same
-- run. desktop_runner_runs is created by the previous migration of this
-- release and holds no row yet, so the check, the index and the foreign key
-- below scan nothing; chat_threads is only locked briefly for the reference.
ALTER TABLE "desktop_runner_runs"
  ADD COLUMN IF NOT EXISTS "chat_thread_id" uuid,
  ADD COLUMN IF NOT EXISTS "chat_read_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_runner_runs"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_chat_read_seq_check"
  CHECK ("chat_read_seq" BETWEEN 0 AND 4294967295);--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "desktop_runner_runs_chat_thread_idx"
  ON "desktop_runner_runs" ("chat_thread_id", "desktop_id", "harness")
  WHERE "chat_thread_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_runner_runs"
  -- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_chat_thread_fk"
  FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;
