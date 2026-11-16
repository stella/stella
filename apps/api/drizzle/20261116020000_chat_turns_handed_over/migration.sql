SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A chat turn can be released by the API task that reads its local run, so
-- another task adopts it and reads the run on: a new unsettled status,
-- 'handed-over', with its stored answer so far and an adopt-by time in the
-- lease column, and no owner. Nothing writes it yet. Both checks are replaced
-- by wider NOT VALID checks and validated online.
-- stella-migration-safety: reviewed drop-constraint - the status check is immediately replaced by a wider NOT VALID check that also accepts handed-over; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "chat_turns" DROP CONSTRAINT IF EXISTS "chat_turns_status_values_check";--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_status_values_check"
  CHECK ("status" IN ('accepted', 'running', 'awaiting-user', 'handed-over', 'completed', 'failed', 'cancelled', 'interrupted')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the state payload check is immediately replaced by a NOT VALID check with the same arms plus one for handed-over; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "chat_turns" DROP CONSTRAINT IF EXISTS "chat_turns_state_payload_check";--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_state_payload_check"
  CHECK (CASE "status"
    WHEN 'accepted' THEN
      "lease_expires_at" IS NOT NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NULL
    WHEN 'running' THEN
      "lease_expires_at" IS NOT NULL AND
      "execution_id" IS NOT NULL AND
      "assistant_message_id" IS NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NULL
    WHEN 'awaiting-user' THEN
      "lease_expires_at" IS NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NOT NULL AND
      "interaction_type" IS NOT NULL AND
      "interaction_tool_call_id" IS NOT NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NULL
    WHEN 'handed-over' THEN
      "lease_expires_at" IS NOT NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NOT NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NULL
    WHEN 'completed' THEN
      "lease_expires_at" IS NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NOT NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NOT NULL
    WHEN 'failed' THEN
      "lease_expires_at" IS NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NOT NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NOT NULL AND
      "failure_retryable" IS NOT NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NOT NULL
    WHEN 'cancelled' THEN
      "lease_expires_at" IS NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NOT NULL AND
      "interruption_reason" IS NULL AND
      "settled_at" IS NOT NULL
    WHEN 'interrupted' THEN
      "lease_expires_at" IS NULL AND
      "execution_id" IS NULL AND
      "assistant_message_id" IS NULL AND
      "interaction_type" IS NULL AND
      "interaction_tool_call_id" IS NULL AND
      "failure_code" IS NULL AND
      "failure_retryable" IS NULL AND
      "cancellation_reason" IS NULL AND
      "interruption_reason" IS NOT NULL AND
      "settled_at" IS NOT NULL
    ELSE false
  END) NOT VALID;--> statement-breakpoint
-- The three indexes whose predicate lists the unsettled statuses are built
-- again with handed-over, under new names, concurrently after deploy by the
-- online migration entry indexes-chat-turns-handed-over-indexes in
-- apps/api/src/db/online-migration-entries/. A later release drops the old
-- ones once the new ones are valid everywhere.
