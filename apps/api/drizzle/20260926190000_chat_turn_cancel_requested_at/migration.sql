SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- When a user first asked to stop the turn. The turn's execution owner reads
-- it and settles the turn as cancelled; a later request never moves it.
-- Nullable with no default, so adding it rewrites no row.
ALTER TABLE "chat_turns" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp with time zone;
