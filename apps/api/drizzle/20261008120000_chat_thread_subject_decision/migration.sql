SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The case-law decision a chat is about, written when the thread is created.
-- Nullable with no default, so adding it rewrites no row.
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "subject_decision_id" uuid;
