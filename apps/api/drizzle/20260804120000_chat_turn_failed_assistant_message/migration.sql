-- The preceding migration allowed a terminal failure without a rendered
-- assistant message. Backfill a stable, server-owned error message before the
-- stricter constraint makes that historical state invalid. MATERIALIZED keeps
-- each generated id identical across the insert and its owning turn update.
WITH failed_turns AS MATERIALIZED (
  SELECT
    "id",
    "thread_id",
    "workspace_id",
    "user_id",
    gen_random_uuid() AS "assistant_message_id"
  FROM "chat_turns"
  WHERE "status" = 'failed'
    AND "assistant_message_id" IS NULL
), inserted_messages AS (
  INSERT INTO "chat_messages" (
    "id",
    "thread_id",
    "workspace_id",
    "user_id",
    "role",
    "content"
  )
  SELECT
    "assistant_message_id",
    "thread_id",
    "workspace_id",
    "user_id",
    'assistant',
    jsonb_build_object(
      'version', 2,
      'data', '[]'::jsonb,
      'metadata', jsonb_build_object(
        'turnOutcome', jsonb_build_object('type', 'failed', 'error', 'unknown')
      )
    )
  FROM failed_turns
  RETURNING "id"
)
UPDATE "chat_turns" AS turn
SET "assistant_message_id" = failed_turns."assistant_message_id"
FROM failed_turns
WHERE turn."id" = failed_turns."id"
  AND turn."status" = 'failed'
  AND turn."assistant_message_id" IS NULL;--> statement-breakpoint

ALTER TABLE "chat_turns"
  DROP CONSTRAINT "chat_turns_state_payload_check";--> statement-breakpoint

ALTER TABLE "chat_turns"
  ADD CONSTRAINT "chat_turns_state_payload_check"
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
  END);
