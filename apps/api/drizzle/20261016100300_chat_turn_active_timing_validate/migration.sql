-- requires: 20261016100200_chat_turn_active_timing
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Commit the additive migration and its receipt before scanning existing rows.
-- Validation is replayable if either scan fails after this transaction split.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "chat_turns"
  VALIDATE CONSTRAINT "chat_turns_timing_message_thread_fk";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';
