SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Where a thread's turns run, as a structured value: null keeps stella's own
-- models, otherwise the coding-agent harness on the member's computer, its
-- model and permission mode, shaped by the API contract's schema. It replaces
-- the encoded text in chat_run_target, which nothing reads or writes any more
-- and a later release drops. Nullable with no default, so adding it rewrites
-- no row.
ALTER TABLE "chat_threads"
  ADD COLUMN IF NOT EXISTS "chat_local_run_target" jsonb;
