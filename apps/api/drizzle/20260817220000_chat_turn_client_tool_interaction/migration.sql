-- stella-migration-safety: reviewed destructive-change - Replaces only the interaction-type value CHECK to admit 'client-tool'; every existing row satisfies the widened set, and rollback can restore the prior CHECK once no row carries the new value.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "chat_turns"
  DROP CONSTRAINT "chat_turns_interaction_values_check";--> statement-breakpoint

ALTER TABLE "chat_turns"
  ADD CONSTRAINT "chat_turns_interaction_values_check"
  CHECK ("interaction_type" IS NULL OR "interaction_type" IN ('ask-user', 'approval', 'client-tool'));
