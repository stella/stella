SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The chat refs a thread's stored messages showed the model, with their
-- targets. Nullable with no default, so the add changes the catalog only; a
-- request derives the value from the stored messages until the thread's next
-- assistant message writes it.
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "ref_state" jsonb;
