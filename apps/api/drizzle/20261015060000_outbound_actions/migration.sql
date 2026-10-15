-- Outbound actions: what the assistant prepared to do as the user outside
-- stella, held until the user confirms the exact preview. Additive: a new
-- table with per user+org row security.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "outbound_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"preview_encrypted" bytea NOT NULL,
	"preview_iv" bytea NOT NULL,
	"preview_hash" varchar(64) NOT NULL,
	"provider_message_id" text,
	"failure_code" varchar(64),
	"expires_at" timestamptz NOT NULL,
	"confirmed_at" timestamptz,
	"completed_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_actions_kind_check" CHECK ("outbound_actions"."kind" IN ('email.send')),
	CONSTRAINT "outbound_actions_status_check" CHECK ("outbound_actions"."status" IN ('pending', 'sending', 'sent', 'failed', 'discarded', 'expired')),
	CONSTRAINT "outbound_actions_preview_hash_check" CHECK ("outbound_actions"."preview_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "outbound_actions_org_user_status_idx" ON "outbound_actions" ("organization_id","user_id","status");--> statement-breakpoint
CREATE INDEX "outbound_actions_chat_thread_idx" ON "outbound_actions" ("chat_thread_id");--> statement-breakpoint
ALTER TABLE "outbound_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbound_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "outbound_actions" TO stella;--> statement-breakpoint
CREATE POLICY "outbound_action_owner" ON "outbound_actions" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.outbound_actions'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.outbound_actions'::regclass));--> statement-breakpoint
CREATE POLICY "outbound_action_select" ON "outbound_actions" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "outbound_action_insert" ON "outbound_actions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "outbound_action_update" ON "outbound_actions" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
)) WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
