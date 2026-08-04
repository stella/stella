SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Prepare the existing message table for the additive composite FKs below.
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires concurrent index operations to run outside a transaction block.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "chat_messages_id_thread_uidx"
  ON "chat_messages" ("id", "thread_id");
--> statement-breakpoint
-- CREATE INDEX CONCURRENTLY can leave this named index INVALID when
-- interrupted. REINDEX INDEX is PostgreSQL's validity repair for that state;
-- it must complete before the composite foreign keys use the index.
REINDEX INDEX CONCURRENTLY "chat_messages_id_thread_uidx";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;

CREATE TABLE "chat_turns" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid,
  "user_id" text NOT NULL,
  "thread_id" uuid NOT NULL,
  "user_message_id" uuid NOT NULL,
  "assistant_message_id" uuid,
  "status" text DEFAULT 'accepted' NOT NULL,
  "execution_id" uuid,
  "lease_expires_at" timestamptz,
  "interaction_type" text,
  "interaction_tool_call_id" text,
  "failure_code" text,
  "failure_retryable" boolean,
  "cancellation_reason" text,
  "interruption_reason" text,
  "settled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chat_turns_status_values_check"
    CHECK ("status" IN ('accepted', 'running', 'awaiting-user', 'completed', 'failed', 'cancelled', 'interrupted')),
  CONSTRAINT "chat_turns_interaction_values_check"
    CHECK ("interaction_type" IS NULL OR "interaction_type" IN ('ask-user', 'approval')),
  CONSTRAINT "chat_turns_failure_code_values_check"
    CHECK ("failure_code" IS NULL OR "failure_code" IN ('boundary-refusal', 'connector-discovery', 'empty-response', 'internal', 'persistence', 'provider-error', 'unsupported-input')),
  CONSTRAINT "chat_turns_cancellation_reason_values_check"
    CHECK ("cancellation_reason" IS NULL OR "cancellation_reason" IN ('superseded', 'user-stop')),
  CONSTRAINT "chat_turns_interruption_reason_values_check"
    CHECK ("interruption_reason" IS NULL OR "interruption_reason" IN ('client-disconnected', 'timeout')),
  CONSTRAINT "chat_turns_state_payload_check"
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
        "assistant_message_id" IS NULL AND
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
    END),
  CONSTRAINT "chat_turns_lease_after_created_check"
    CHECK ("lease_expires_at" IS NULL OR "lease_expires_at" > "created_at"),
  CONSTRAINT "chat_turns_settled_after_created_check"
    CHECK ("settled_at" IS NULL OR "settled_at" >= "created_at")
);--> statement-breakpoint
ALTER TABLE "chat_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_thread_id_chat_threads_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_user_message_thread_fk"
  FOREIGN KEY ("user_message_id", "thread_id") REFERENCES "chat_messages"("id", "thread_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_assistant_message_thread_fk"
  FOREIGN KEY ("assistant_message_id", "thread_id") REFERENCES "chat_messages"("id", "thread_id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX "chat_turns_active_thread_uidx"
  ON "chat_turns" ("thread_id")
  WHERE "status" IN ('accepted', 'running', 'awaiting-user');--> statement-breakpoint
CREATE INDEX "chat_turns_org_user_thread_created_idx"
  ON "chat_turns" ("organization_id", "user_id", "thread_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "chat_turns_org_user_message_created_idx"
  ON "chat_turns" ("organization_id", "user_message_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "chat_turns_org_active_lease_idx"
  ON "chat_turns" ("organization_id", "status", "lease_expires_at", "id")
  WHERE "status" IN ('accepted', 'running');--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_turns" TO stella;--> statement-breakpoint

CREATE POLICY "chat_turn_select" ON "chat_turns" AS PERMISSIVE FOR SELECT TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      workspace_id IS NULL
      OR CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
    )
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_turns.thread_id
        AND ct.user_id = chat_turns.user_id
        AND ct.organization_id = chat_turns.organization_id
        AND ct.workspace_id IS NOT DISTINCT FROM chat_turns.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
    )
  );--> statement-breakpoint

CREATE POLICY "chat_turn_insert" ON "chat_turns" AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      workspace_id IS NULL
      OR CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
    )
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_turns.thread_id
        AND ct.user_id = chat_turns.user_id
        AND ct.organization_id = chat_turns.organization_id
        AND ct.workspace_id IS NOT DISTINCT FROM chat_turns.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
    )
  );--> statement-breakpoint

CREATE POLICY "chat_turn_update" ON "chat_turns" AS PERMISSIVE FOR UPDATE TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      workspace_id IS NULL
      OR CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
    )
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_turns.thread_id
        AND ct.user_id = chat_turns.user_id
        AND ct.organization_id = chat_turns.organization_id
        AND ct.workspace_id IS NOT DISTINCT FROM chat_turns.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
    )
  )
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      workspace_id IS NULL
      OR CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
    )
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_turns.thread_id
        AND ct.user_id = chat_turns.user_id
        AND ct.organization_id = chat_turns.organization_id
        AND ct.workspace_id IS NOT DISTINCT FROM chat_turns.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
    )
  );--> statement-breakpoint

CREATE POLICY "chat_turn_delete" ON "chat_turns" AS PERMISSIVE FOR DELETE TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      workspace_id IS NULL
      OR CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
    )
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_turns.thread_id
        AND ct.user_id = chat_turns.user_id
        AND ct.organization_id = chat_turns.organization_id
        AND ct.workspace_id IS NOT DISTINCT FROM chat_turns.workspace_id
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
    )
  );
