SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "entity_views" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "name" varchar(256) NOT NULL,
  "layout" jsonb NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "entity_views_layout_version_check" CHECK ((jsonb_typeof("layout") = 'object' AND "layout"->'version' = '1'::jsonb) IS TRUE),
  CONSTRAINT "entity_views_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "entity_views_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "entity_views_org_user_position_idx" ON "entity_views" ("organization_id", "user_id", "position");--> statement-breakpoint
ALTER TABLE "entity_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "entity_view_select" ON "entity_views" AS PERMISSIVE FOR SELECT TO "stella" USING ((organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "entity_view_insert" ON "entity_views" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "entity_view_update" ON "entity_views" AS PERMISSIVE FOR UPDATE TO "stella" USING ((organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true)))) WITH CHECK ((organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "entity_view_delete" ON "entity_views" AS PERMISSIVE FOR DELETE TO "stella" USING ((organization_id = (SELECT current_setting('app.organization_id', true)) AND user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
