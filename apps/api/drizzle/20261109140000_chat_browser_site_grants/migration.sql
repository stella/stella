-- Stored per-site approvals for chat's browser actions, owned by the API.
-- Additive: a new table with per user+org row security.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "chat_browser_site_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"origin" varchar(512) NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "chat_browser_site_grants_origin_key" UNIQUE ("organization_id", "user_id", "origin"),
	CONSTRAINT "chat_browser_site_grants_https_origin_check" CHECK ("chat_browser_site_grants"."origin" LIKE 'https://%')
);
--> statement-breakpoint
ALTER TABLE "chat_browser_site_grants" ADD CONSTRAINT "chat_browser_site_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_browser_site_grants" ADD CONSTRAINT "chat_browser_site_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_browser_site_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_browser_site_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_browser_site_grants" TO stella;--> statement-breakpoint
CREATE POLICY "chat_browser_site_grant_owner" ON "chat_browser_site_grants" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_browser_site_grants'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_browser_site_grants'::regclass));--> statement-breakpoint
CREATE POLICY "chat_browser_site_grant_select" ON "chat_browser_site_grants" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_browser_site_grant_insert" ON "chat_browser_site_grants" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_browser_site_grant_delete" ON "chat_browser_site_grants" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_browser_site_grant_no_update" ON "chat_browser_site_grants" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);
