SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "correspondence" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "direction" text NOT NULL,
  "channel" text NOT NULL,
  "message_id" text,
  "content_hash" varchar(64) NOT NULL,
  "dedup_key" varchar(64) NOT NULL,
  "sender" jsonb NOT NULL,
  "recipients_to" jsonb NOT NULL,
  "recipients_cc" jsonb NOT NULL,
  "subject" text NOT NULL,
  "sent_at" timestamptz,
  "received_at" timestamptz NOT NULL,
  "in_reply_to" text,
  "references" jsonb NOT NULL,
  "body_text" text NOT NULL,
  "body_html" text,
  "spf" text NOT NULL,
  "dkim" text NOT NULL,
  "dmarc" text NOT NULL,
  "aligned_identifier" text,
  "handling_state" text DEFAULT 'new' NOT NULL,
  "assignee_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "correspondence_id_ws_unq" UNIQUE ("id", "workspace_id"),
  CONSTRAINT "correspondence_direction_check" CHECK ("direction" in ('in', 'out')),
  CONSTRAINT "correspondence_channel_check" CHECK ("channel" in ('email')),
  CONSTRAINT "correspondence_handling_check" CHECK ("handling_state" in ('new', 'handled')),
  CONSTRAINT "correspondence_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$' and "dedup_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "correspondence_auth_check" CHECK ("spf" in ('pass', 'fail', 'none', 'unknown') and "dkim" in ('pass', 'fail', 'none', 'unknown') and "dmarc" in ('pass', 'fail', 'none', 'unknown')),
  CONSTRAINT "correspondence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "correspondence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade,
  CONSTRAINT "correspondence_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "correspondence_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_ws_dedup_uidx" ON "correspondence" ("workspace_id", "dedup_key");--> statement-breakpoint
CREATE INDEX "correspondence_ws_received_idx" ON "correspondence" ("workspace_id", "received_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "correspondence_ws_assignee_idx" ON "correspondence" ("workspace_id", "assignee_id", "handling_state");--> statement-breakpoint

CREATE TABLE "correspondence_filers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "correspondence_id" uuid NOT NULL,
  "filed_by_user_id" text,
  "filed_by_allowed_sender_id" uuid,
  "filed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "correspondence_filers_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "correspondence_filers_record_workspace_fk" FOREIGN KEY ("correspondence_id", "workspace_id") REFERENCES "correspondence"("id", "workspace_id") ON DELETE cascade,
  CONSTRAINT "correspondence_filers_filed_by_user_id_user_id_fk" FOREIGN KEY ("filed_by_user_id") REFERENCES "user"("id") ON DELETE restrict,
  CONSTRAINT "correspondence_filers_actor_check" CHECK (("filed_by_user_id" is null) <> ("filed_by_allowed_sender_id" is null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_filers_record_user_uidx" ON "correspondence_filers" ("correspondence_id", "filed_by_user_id") WHERE "filed_by_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_filers_record_sender_uidx" ON "correspondence_filers" ("correspondence_id", "filed_by_allowed_sender_id") WHERE "filed_by_allowed_sender_id" is not null;--> statement-breakpoint
CREATE INDEX "correspondence_filers_ws_record_idx" ON "correspondence_filers" ("workspace_id", "correspondence_id");--> statement-breakpoint

CREATE TABLE "correspondence_attachments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "correspondence_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "filename" text NOT NULL,
  "media_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "scan_verdict" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "correspondence_attachments_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "correspondence_attachments_record_workspace_fk" FOREIGN KEY ("correspondence_id", "workspace_id") REFERENCES "correspondence"("id", "workspace_id") ON DELETE cascade,
  CONSTRAINT "correspondence_attachments_entity_workspace_fk" FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE cascade,
  CONSTRAINT "correspondence_attachments_size_check" CHECK ("byte_size" >= 0 and "ordinal" >= 0),
  CONSTRAINT "correspondence_attachments_scan_check" CHECK ("scan_verdict" in ('clean', 'infected', 'unknown'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_attachments_record_ordinal_uidx" ON "correspondence_attachments" ("correspondence_id", "ordinal");--> statement-breakpoint
CREATE INDEX "correspondence_attachments_ws_record_idx" ON "correspondence_attachments" ("workspace_id", "correspondence_id");--> statement-breakpoint

CREATE TABLE "matter_inbound_addresses" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "token" varchar(128) NOT NULL,
  "created_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by" text,
  CONSTRAINT "matter_inbound_addresses_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "matter_inbound_addresses_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null,
  CONSTRAINT "matter_inbound_addresses_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "user"("id") ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX "matter_inbound_addresses_token_uidx" ON "matter_inbound_addresses" ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_inbound_addresses_active_uidx" ON "matter_inbound_addresses" ("workspace_id") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "matter_inbound_addresses_ws_created_idx" ON "matter_inbound_addresses" ("workspace_id", "created_at" DESC);--> statement-breakpoint

CREATE TABLE "correspondence_allowed_senders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "address" text NOT NULL,
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  "owner_user_id" text,
  "approved_by" text,
  "approved_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "correspondence_allowed_senders_id_org_unq" UNIQUE ("id", "organization_id"),
  CONSTRAINT "correspondence_allowed_senders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "correspondence_allowed_senders_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "correspondence_allowed_senders_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE restrict,
  CONSTRAINT "correspondence_allowed_senders_kind_check" CHECK ("kind" in ('verified_alias', 'shared_mailbox')),
  CONSTRAINT "correspondence_allowed_senders_scope_check" CHECK ("scope" in ('organization', 'matters')),
  CONSTRAINT "correspondence_allowed_senders_owner_check" CHECK (("kind" = 'verified_alias') = ("owner_user_id" is not null)),
  CONSTRAINT "correspondence_allowed_senders_approval_check" CHECK ("kind" <> 'shared_mailbox' or "approved_by" is not null)
);--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_allowed_senders_active_uidx" ON "correspondence_allowed_senders" ("organization_id", "address") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "correspondence_allowed_senders_org_kind_idx" ON "correspondence_allowed_senders" ("organization_id", "kind");--> statement-breakpoint

CREATE TABLE "correspondence_allowed_sender_matters" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "allowed_sender_id" uuid NOT NULL,
  CONSTRAINT "correspondence_allowed_sender_matters_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "correspondence_allowed_sender_matters_sender_organization_fk" FOREIGN KEY ("allowed_sender_id", "organization_id") REFERENCES "correspondence_allowed_senders"("id", "organization_id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_allowed_sender_matters_sender_ws_uidx" ON "correspondence_allowed_sender_matters" ("allowed_sender_id", "workspace_id");--> statement-breakpoint
CREATE INDEX "correspondence_allowed_sender_matters_ws_sender_idx" ON "correspondence_allowed_sender_matters" ("workspace_id", "allowed_sender_id");--> statement-breakpoint

ALTER TABLE "correspondence_filers" ADD CONSTRAINT "correspondence_filers_sender_organization_fk" FOREIGN KEY ("filed_by_allowed_sender_id", "organization_id") REFERENCES "correspondence_allowed_senders"("id", "organization_id") ON DELETE restrict;--> statement-breakpoint

CREATE TABLE "correspondence_drop_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "sender_address" text NOT NULL,
  "reason" text NOT NULL,
  "received_at" timestamptz NOT NULL,
  CONSTRAINT "correspondence_drop_logs_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade,
  CONSTRAINT "correspondence_drop_logs_reason_check" CHECK ("reason" in ('unknown_recipient', 'revoked_address', 'unauthorized_sender', 'authentication_failed', 'message_too_large', 'attachment_rejected', 'malformed_message'))
);--> statement-breakpoint
CREATE INDEX "correspondence_drop_logs_ws_received_idx" ON "correspondence_drop_logs" ("workspace_id", "received_at" DESC, "id" DESC);--> statement-breakpoint

-- Each table carries both organization and matter scope; RLS keeps direct SQL
-- access aligned with the authorized workspace set.
ALTER TABLE "correspondence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "correspondence" TO "stella";--> statement-breakpoint
CREATE POLICY "correspondence_workspace_select" ON "correspondence" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_workspace_insert" ON "correspondence" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_workspace_update" ON "correspondence" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_workspace_delete" ON "correspondence" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "correspondence_filers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_filers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "correspondence_filers" TO "stella";--> statement-breakpoint
CREATE POLICY "correspondence_filers_workspace_select" ON "correspondence_filers" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_filers_workspace_insert" ON "correspondence_filers" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_filers_workspace_update" ON "correspondence_filers" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_filers_workspace_delete" ON "correspondence_filers" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "correspondence_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "correspondence_attachments" TO "stella";--> statement-breakpoint
CREATE POLICY "correspondence_attachments_workspace_select" ON "correspondence_attachments" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_attachments_workspace_insert" ON "correspondence_attachments" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_attachments_workspace_update" ON "correspondence_attachments" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_attachments_workspace_delete" ON "correspondence_attachments" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "matter_inbound_addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_inbound_addresses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "matter_inbound_addresses_owner_lookup" ON "matter_inbound_addresses" FOR SELECT TO CURRENT_USER USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "matter_inbound_addresses" TO "stella";--> statement-breakpoint
CREATE POLICY "matter_inbound_addresses_workspace_select" ON "matter_inbound_addresses" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "matter_inbound_addresses_workspace_insert" ON "matter_inbound_addresses" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "matter_inbound_addresses_workspace_update" ON "matter_inbound_addresses" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "matter_inbound_addresses_workspace_delete" ON "matter_inbound_addresses" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "correspondence_allowed_senders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_allowed_senders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "correspondence_allowed_senders_owner_lookup" ON "correspondence_allowed_senders" FOR SELECT TO CURRENT_USER USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "correspondence_allowed_senders" TO "stella";--> statement-breakpoint
CREATE POLICY "organization_select" ON "correspondence_allowed_senders" FOR SELECT TO "stella" USING ("organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "correspondence_allowed_senders" FOR INSERT TO "stella" WITH CHECK ("organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "correspondence_allowed_senders" FOR UPDATE TO "stella" USING ("organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "correspondence_allowed_senders" FOR DELETE TO "stella" USING ("organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "correspondence_allowed_sender_matters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_allowed_sender_matters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "correspondence_allowed_sender_matters_owner_lookup" ON "correspondence_allowed_sender_matters" FOR SELECT TO CURRENT_USER USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "correspondence_allowed_sender_matters" TO "stella";--> statement-breakpoint
CREATE POLICY "correspondence_allowed_sender_matters_workspace_select" ON "correspondence_allowed_sender_matters" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_allowed_sender_matters_workspace_insert" ON "correspondence_allowed_sender_matters" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_allowed_sender_matters_workspace_update" ON "correspondence_allowed_sender_matters" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_allowed_sender_matters_workspace_delete" ON "correspondence_allowed_sender_matters" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
ALTER TABLE "correspondence_drop_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_drop_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "correspondence_drop_logs" TO "stella";--> statement-breakpoint
CREATE POLICY "correspondence_drop_logs_workspace_select" ON "correspondence_drop_logs" FOR SELECT TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_drop_logs_workspace_insert" ON "correspondence_drop_logs" FOR INSERT TO "stella" WITH CHECK (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_drop_logs_workspace_update" ON "correspondence_drop_logs" FOR UPDATE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "correspondence_drop_logs_workspace_delete" ON "correspondence_drop_logs" FOR DELETE TO "stella" USING (("workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) OR "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)) AND "organization_id" = (SELECT pg_catalog.current_setting('app.organization_id', true)));--> statement-breakpoint
