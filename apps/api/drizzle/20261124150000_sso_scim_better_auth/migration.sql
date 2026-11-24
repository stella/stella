SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "scim_managed_connection" (
  "id" text PRIMARY KEY NOT NULL,
  "creation_request_id" text NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "status" text NOT NULL,
  "revision" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "created_by" text NOT NULL,
  "decommission_started_at" timestamp with time zone,
  "decommission_started_by" text,
  "decommissioned_at" timestamp with time zone,
  "decommissioned_by" text
);--> statement-breakpoint
CREATE UNIQUE INDEX "scim_managed_conn_creation_req_uidx" ON "scim_managed_connection" ("creation_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_managed_conn_connection_id_uidx" ON "scim_managed_connection" ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_managed_conn_domain_idx" ON "scim_managed_connection" ("provisioning_domain_id");--> statement-breakpoint
ALTER TABLE "scim_managed_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_managed_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_managed_connection_owner_access"
  ON "scim_managed_connection" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_managed_connection'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_managed_connection'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_managed_connection"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_managed_connection" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_managed_credential" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_record_id" text NOT NULL REFERENCES "scim_managed_connection"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "token_digest" text NOT NULL,
  "hash_version" text NOT NULL,
  "active_slot_key" text NOT NULL,
  "status" text NOT NULL,
  "serialized_scopes" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "created_by" text NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "decommissioned_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "scim_managed_cred_conn_rec_idx" ON "scim_managed_credential" ("connection_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_managed_cred_id_uidx" ON "scim_managed_credential" ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_managed_cred_active_slot_uidx" ON "scim_managed_credential" ("active_slot_key");--> statement-breakpoint
ALTER TABLE "scim_managed_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_managed_credential" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_managed_credential_owner_access"
  ON "scim_managed_credential" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_managed_credential'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_managed_credential'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_managed_credential"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_managed_credential" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_managed_connection_event" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_record_id" text NOT NULL REFERENCES "scim_managed_connection"("id") ON DELETE CASCADE,
  "event_key" text NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "actor_id" text NOT NULL,
  "credential_id" text,
  "created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "scim_managed_evt_conn_rec_idx" ON "scim_managed_connection_event" ("connection_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_managed_evt_key_uidx" ON "scim_managed_connection_event" ("event_key");--> statement-breakpoint
ALTER TABLE "scim_managed_connection_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_managed_connection_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_managed_connection_event_owner_access"
  ON "scim_managed_connection_event" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_managed_connection_event'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_managed_connection_event'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_managed_connection_event"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_managed_connection_event" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_connection_binding" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "connection_key" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "decommissioned_at" timestamp with time zone,
  "decommission_status" text DEFAULT 'active' NOT NULL,
  "decommission_cursor_user_id" text,
  "decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
  "decommission_batch_count" integer DEFAULT 0 NOT NULL,
  "decommission_revision" integer DEFAULT 0 NOT NULL,
  "decommission_completed_at" timestamp with time zone,
  "decommission_lease_id" text,
  "decommission_lease_expires_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "scim_conn_binding_conn_id_idx" ON "scim_connection_binding" ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_conn_binding_conn_key_uidx" ON "scim_connection_binding" ("connection_key");--> statement-breakpoint
ALTER TABLE "scim_connection_binding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_connection_binding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_connection_binding_owner_access"
  ON "scim_connection_binding" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_connection_binding'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_connection_binding'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_connection_binding"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_connection_binding" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_identity_tombstone" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "external_id" text NOT NULL,
  "external_id_key" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "profile" text NOT NULL,
  "deleted_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "scim_tombstone_conn_id_idx" ON "scim_identity_tombstone" ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_tombstone_domain_idx" ON "scim_identity_tombstone" ("provisioning_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tombstone_ext_id_key_uidx" ON "scim_identity_tombstone" ("external_id_key");--> statement-breakpoint
CREATE INDEX "scim_tombstone_user_id_idx" ON "scim_identity_tombstone" ("user_id");--> statement-breakpoint
ALTER TABLE "scim_identity_tombstone" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_identity_tombstone" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_identity_tombstone_owner_access"
  ON "scim_identity_tombstone" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_identity_tombstone'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_identity_tombstone'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_identity_tombstone"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_identity_tombstone" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_subject" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "profile_source_id" text,
  "revision" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "scim_subject_user_id_uidx" ON "scim_subject" ("user_id");--> statement-breakpoint
CREATE INDEX "scim_subject_profile_source_idx" ON "scim_subject" ("profile_source_id");--> statement-breakpoint
ALTER TABLE "scim_subject" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_subject" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_subject_owner_access"
  ON "scim_subject" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_subject'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_subject'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_subject"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_subject" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_user" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "connection_user_key" text NOT NULL,
  "user_name" text NOT NULL,
  "user_name_key" text NOT NULL,
  "primary_email" text NOT NULL,
  "work_email_value_index" text NOT NULL,
  "email_value_index" text NOT NULL,
  "display_name" text NOT NULL,
  "formatted_name" text NOT NULL,
  "given_name" text,
  "family_name" text,
  "serialized_emails" text NOT NULL,
  "serialized_attributes" text,
  "external_id" text,
  "external_id_key" text,
  "active" boolean NOT NULL,
  "order_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "scim_user_conn_id_idx" ON "scim_user" ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_user_domain_idx" ON "scim_user" ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_user_user_id_idx" ON "scim_user" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_conn_user_key_uidx" ON "scim_user" ("connection_user_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_username_key_uidx" ON "scim_user" ("user_name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_ext_id_key_uidx" ON "scim_user" ("external_id_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_order_key_uidx" ON "scim_user" ("order_key");--> statement-breakpoint
ALTER TABLE "scim_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_user_owner_access"
  ON "scim_user" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_user'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_user'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_user"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_user" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_projection_grant" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "scim_user_id" text NOT NULL REFERENCES "scim_user"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "source_value" text,
  "role" text NOT NULL,
  "grant_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "scim_proj_grant_conn_id_idx" ON "scim_projection_grant" ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_proj_grant_domain_idx" ON "scim_projection_grant" ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_proj_grant_scim_user_idx" ON "scim_projection_grant" ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_proj_grant_user_id_idx" ON "scim_projection_grant" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_proj_grant_key_uidx" ON "scim_projection_grant" ("grant_key");--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_projection_grant_owner_access"
  ON "scim_projection_grant" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_projection_grant'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_projection_grant'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_projection_grant"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_projection_grant" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_group" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "display_name" text NOT NULL,
  "display_name_key" text NOT NULL,
  "external_id" text,
  "external_id_key" text,
  "order_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "scim_group_conn_id_idx" ON "scim_group" ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_domain_idx" ON "scim_group" ("provisioning_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_display_name_key_uidx" ON "scim_group" ("display_name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_ext_id_key_uidx" ON "scim_group" ("external_id_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_order_key_uidx" ON "scim_group" ("order_key");--> statement-breakpoint
ALTER TABLE "scim_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_group" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_group_owner_access"
  ON "scim_group" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_group'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_group'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_group"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_group" FROM stella;--> statement-breakpoint

CREATE TABLE "scim_group_member" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "group_id" text NOT NULL REFERENCES "scim_group"("id") ON DELETE CASCADE,
  "scim_user_id" text NOT NULL REFERENCES "scim_user"("id") ON DELETE CASCADE,
  "membership_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "scim_group_member_conn_id_idx" ON "scim_group_member" ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_group_id_idx" ON "scim_group_member" ("group_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_scim_user_idx" ON "scim_group_member" ("scim_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_member_key_uidx" ON "scim_group_member" ("membership_key");--> statement-breakpoint
ALTER TABLE "scim_group_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_group_member" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scim_group_member_owner_access"
  ON "scim_group_member" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_group_member'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scim_group_member'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "scim_group_member"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "scim_group_member" FROM stella;
