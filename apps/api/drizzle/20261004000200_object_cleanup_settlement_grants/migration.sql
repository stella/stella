SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The request role holds UPDATE on "buffer_object_cleanup_intents" column by
-- column (20260830150000_workspace_reference_cleanup_indexes granted "status").
-- A writer that claims its own exact-key intent for cleanup, or hands an
-- uncertain write to recovery, also schedules the recovery attempt: it resets
-- "attempt_count" and sets "next_attempt_at" in the same scoped statement, so
-- the role needs UPDATE on exactly those two columns as well. Object keys,
-- ownership columns and every other column stay root-only; the row policies
-- still limit which intents the role can reach.
GRANT UPDATE ("attempt_count", "next_attempt_at")
  ON TABLE "buffer_object_cleanup_intents"
  TO stella;
