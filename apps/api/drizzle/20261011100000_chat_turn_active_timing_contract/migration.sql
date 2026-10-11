-- requires: 20261008160200_chat_turn_active_timing_validate
-- Add the timing invariant after the additive columns and FK validation.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "chat_turns"
  ADD CONSTRAINT "chat_turns_active_timing_check" CHECK (
    ("active_duration_ms" IS NULL AND "active_started_at" IS NULL) OR
    ("active_duration_ms" IS NOT NULL AND "active_duration_ms" >= 0 AND (("status" IN ('accepted', 'running')) = ("active_started_at" IS NOT NULL)))
  ) NOT VALID;--> statement-breakpoint

-- Commit the constraint addition before scanning existing rows.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "chat_turns"
  VALIDATE CONSTRAINT "chat_turns_active_timing_check";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';
