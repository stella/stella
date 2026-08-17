-- stella-migration-safety: reviewed destructive-change - Replaces only the interaction-type value CHECK to admit 'client-tool'; every existing row satisfies the widened set, and rollback can restore the prior CHECK once no row carries the new value.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "chat_turns"
  DROP CONSTRAINT "chat_turns_interaction_values_check";--> statement-breakpoint

ALTER TABLE "chat_turns"
  ADD CONSTRAINT "chat_turns_interaction_values_check"
  CHECK ("interaction_type" IS NULL OR "interaction_type" IN ('ask-user', 'approval', 'client-tool')) NOT VALID;--> statement-breakpoint

-- Validate outside Drizzle's migration transaction so PostgreSQL does not
-- hold the ADD CONSTRAINT lock for the duration of the table scan.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
ALTER TABLE "chat_turns"
  VALIDATE CONSTRAINT "chat_turns_interaction_values_check";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
