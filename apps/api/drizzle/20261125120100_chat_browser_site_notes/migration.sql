-- Research notes about a website's mechanics, kept per member and website.
-- Additive: a new table with per user+org row security.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "chat_browser_site_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"origin" varchar(512) NOT NULL,
	"kind" text NOT NULL,
	"step" varchar(80) NOT NULL,
	"text" varchar(300) NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"confirmed_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "chat_browser_site_notes_content_key" UNIQUE ("organization_id", "user_id", "origin", "kind", "step", "text"),
	CONSTRAINT "chat_browser_site_notes_https_origin_check" CHECK ("chat_browser_site_notes"."origin" LIKE 'https://%'),
	CONSTRAINT "chat_browser_site_notes_kind_check" CHECK ("chat_browser_site_notes"."kind" IN ('works', 'failed', 'fixed'))
);
--> statement-breakpoint
CREATE INDEX "chat_browser_site_notes_site_idx" ON "chat_browser_site_notes" ("organization_id", "user_id", "origin", "confirmed_at");--> statement-breakpoint
ALTER TABLE "chat_browser_site_notes" ADD CONSTRAINT "chat_browser_site_notes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_browser_site_notes" ADD CONSTRAINT "chat_browser_site_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_browser_site_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_browser_site_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_browser_site_notes" TO stella;--> statement-breakpoint
CREATE POLICY "chat_browser_site_note_owner" ON "chat_browser_site_notes" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_browser_site_notes'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_browser_site_notes'::regclass));--> statement-breakpoint
CREATE POLICY "chat_browser_site_note_select" ON "chat_browser_site_notes" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_browser_site_note_insert" ON "chat_browser_site_notes" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_browser_site_note_update" ON "chat_browser_site_notes" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
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
));--> statement-breakpoint
CREATE POLICY "chat_browser_site_note_delete" ON "chat_browser_site_notes" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
