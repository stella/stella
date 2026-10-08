SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "chat_secrets" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "thread_id" uuid NOT NULL REFERENCES "chat_threads"("id") ON DELETE CASCADE,
  "tool_call_id" text NOT NULL,
  "connector_id" uuid REFERENCES "mcp_connectors"("id") ON DELETE SET NULL,
  "target_slug" varchar(80) NOT NULL,
  "target_url" text NOT NULL,
  "decision" text NOT NULL,
  "ciphertext" bytea,
  "iv" bytea,
  "expires_at" timestamptz NOT NULL,
  "remaining_uses" integer DEFAULT 8 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chat_secrets_decision_check" CHECK (
    (decision = 'provided' AND remaining_uses > 0 AND ciphertext IS NOT NULL AND iv IS NOT NULL)
    OR (decision = 'provided' AND remaining_uses = 0 AND ciphertext IS NULL AND iv IS NULL)
    OR (decision = 'declined' AND remaining_uses = 0 AND ciphertext IS NULL AND iv IS NULL)
  ),
  CONSTRAINT "chat_secrets_remaining_uses_check" CHECK (remaining_uses BETWEEN 0 AND 8),
  CONSTRAINT "chat_secrets_expiry_check" CHECK (expires_at <= created_at::timestamptz + interval '24 hours')
);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_secrets_request_uidx" ON "chat_secrets" (organization_id, user_id, thread_id, tool_call_id);--> statement-breakpoint
CREATE INDEX "chat_secrets_thread_idx" ON "chat_secrets" (thread_id);--> statement-breakpoint
CREATE INDEX "chat_secrets_connector_idx" ON "chat_secrets" (connector_id);--> statement-breakpoint
CREATE INDEX "chat_secrets_user_idx" ON "chat_secrets" (user_id);--> statement-breakpoint
CREATE INDEX "chat_secrets_expiry_idx" ON "chat_secrets" (expires_at);--> statement-breakpoint
ALTER TABLE "chat_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_secrets" TO stella;--> statement-breakpoint
CREATE POLICY "chat_secret_select" ON "chat_secrets" AS PERMISSIVE FOR SELECT TO "stella" USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_secrets.thread_id
      AND ct.organization_id = chat_secrets.organization_id
      AND ct.user_id = chat_secrets.user_id
  )
);--> statement-breakpoint
CREATE POLICY "chat_secret_insert" ON "chat_secrets" AS PERMISSIVE FOR INSERT TO "stella"  WITH CHECK (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_secrets.thread_id
      AND ct.organization_id = chat_secrets.organization_id
      AND ct.user_id = chat_secrets.user_id
  )
);--> statement-breakpoint
CREATE POLICY "chat_secret_update" ON "chat_secrets" AS PERMISSIVE FOR UPDATE TO "stella" USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_secrets.thread_id
      AND ct.organization_id = chat_secrets.organization_id
      AND ct.user_id = chat_secrets.user_id
  )
) WITH CHECK (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_secrets.thread_id
      AND ct.organization_id = chat_secrets.organization_id
      AND ct.user_id = chat_secrets.user_id
  )
);--> statement-breakpoint
CREATE POLICY "chat_secret_delete" ON "chat_secrets" AS PERMISSIVE FOR DELETE TO "stella" USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_secrets.thread_id
      AND ct.organization_id = chat_secrets.organization_id
      AND ct.user_id = chat_secrets.user_id
  )
);--> statement-breakpoint
CREATE POLICY "chat_secrets_owner_access" ON "chat_secrets" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_secrets'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_secrets'::regclass));
--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "response_disposition" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "response_target_url" text;--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD CONSTRAINT "mcp_user_connections_response_disposition_check" CHECK (response_disposition IN ('normal', 'receipt-only')) NOT VALID;--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD CONSTRAINT "mcp_user_connections_response_target_check" CHECK (response_disposition = 'normal' OR (response_target_url IS NOT NULL AND static_token_encrypted IS NOT NULL AND static_token_iv IS NOT NULL AND access_token_encrypted IS NULL AND access_token_iv IS NULL AND refresh_token_encrypted IS NULL AND refresh_token_iv IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "mcp_user_connections" VALIDATE CONSTRAINT "mcp_user_connections_response_disposition_check";--> statement-breakpoint
ALTER TABLE "mcp_user_connections" VALIDATE CONSTRAINT "mcp_user_connections_response_target_check";
