SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A run started for a chat turn names the turn that reads it, so the run ends
-- once that turn does. Nullable with no default, so adding it rewrites no row.
-- desktop_runner_runs holds a handful of rows at most: runner sockets are
-- invitation-only and ended runs are pruned. The index and the foreign key
-- below scan only those rows within the timeouts above; chat_turns is only
-- locked briefly for the reference.
ALTER TABLE "desktop_runner_runs"
  ADD COLUMN IF NOT EXISTS "chat_turn_id" uuid;--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "desktop_runner_runs_chat_turn_idx"
  ON "desktop_runner_runs" ("chat_turn_id")
  WHERE "chat_turn_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_runner_runs"
  -- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_chat_turn_fk"
  FOREIGN KEY ("chat_turn_id") REFERENCES "chat_turns"("id") ON DELETE CASCADE;
