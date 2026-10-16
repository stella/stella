-- Stored chat tool approval grants, owned by the API instead of the browser.
-- Additive: a new table with per user+org row security.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "chat_tool_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"chat_thread_id" uuid,
	"tool_name" varchar(128),
	"mcp_connector_id" uuid,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "chat_tool_grants_subject_key" UNIQUE NULLS NOT DISTINCT ("organization_id", "user_id", "scope", "chat_thread_id", "tool_name", "mcp_connector_id"),
	CONSTRAINT "chat_tool_grants_scope_check" CHECK ("chat_tool_grants"."scope" IN ('conversation', 'always')),
	CONSTRAINT "chat_tool_grants_scope_thread_check" CHECK (("chat_tool_grants"."scope" = 'conversation') = ("chat_tool_grants"."chat_thread_id" IS NOT NULL)),
	CONSTRAINT "chat_tool_grants_one_subject_check" CHECK (("chat_tool_grants"."tool_name" IS NULL) <> ("chat_tool_grants"."mcp_connector_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_tool_grants" ADD CONSTRAINT "chat_tool_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_tool_grants" ADD CONSTRAINT "chat_tool_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_tool_grants" ADD CONSTRAINT "chat_tool_grants_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_tool_grants" ADD CONSTRAINT "chat_tool_grants_mcp_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("mcp_connector_id") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "chat_tool_grants_org_user_scope_idx" ON "chat_tool_grants" ("organization_id","user_id","scope");--> statement-breakpoint
CREATE INDEX "chat_tool_grants_chat_thread_idx" ON "chat_tool_grants" ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "chat_tool_grants_mcp_connector_idx" ON "chat_tool_grants" ("mcp_connector_id");--> statement-breakpoint
ALTER TABLE "chat_tool_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_tool_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_tool_grants" TO stella;--> statement-breakpoint
CREATE POLICY "chat_tool_grant_owner" ON "chat_tool_grants" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_tool_grants'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_tool_grants'::regclass));--> statement-breakpoint
CREATE POLICY "chat_tool_grant_select" ON "chat_tool_grants" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_tool_grant_insert" ON "chat_tool_grants" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_tool_grant_delete" ON "chat_tool_grants" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_tool_grant_no_update" ON "chat_tool_grants" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);
