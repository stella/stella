-- requires: 20261008160200_chat_turn_active_timing_validate
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Concurrent builds must run outside the migrator transaction.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- A cancelled build can leave an invalid index; recreate it on every replay.
DROP INDEX CONCURRENTLY IF EXISTS "chat_turns_org_timing_message_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "chat_turns_org_timing_message_idx"
  ON "chat_turns" ("organization_id", "timing_message_id");--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
