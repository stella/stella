CREATE TABLE "workspace_view_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"layout" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_view_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_view_templates" ADD CONSTRAINT "workspace_view_templates_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "workspace_view_templates" ADD CONSTRAINT "workspace_view_templates_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_view_templates_user_name_uidx" ON "workspace_view_templates" USING btree ("organization_id","user_id","name");
--> statement-breakpoint
CREATE INDEX "workspace_view_templates_user_created_idx" ON "workspace_view_templates" USING btree ("organization_id","user_id","created_at");
--> statement-breakpoint
CREATE POLICY "workspace_view_template_select" ON "workspace_view_templates" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "workspace_view_template_insert" ON "workspace_view_templates" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
CREATE POLICY "workspace_view_template_update" ON "workspace_view_templates" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
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
--> statement-breakpoint
CREATE POLICY "workspace_view_template_delete" ON "workspace_view_templates" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workspace_view_templates" TO stella;
