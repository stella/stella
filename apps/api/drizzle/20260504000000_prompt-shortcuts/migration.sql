CREATE TABLE "prompt_shortcuts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"command" varchar(50) NOT NULL,
	"prompt" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompt_shortcuts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prompt_shortcuts" ADD CONSTRAINT "prompt_shortcuts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "prompt_shortcuts" ADD CONSTRAINT "prompt_shortcuts_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_shortcuts_org_team_command_uidx" ON "prompt_shortcuts" USING btree ("organization_id","command") WHERE scope = 'team';--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_shortcuts_user_private_command_uidx" ON "prompt_shortcuts" USING btree ("user_id","command") WHERE scope = 'private';--> statement-breakpoint
CREATE INDEX "prompt_shortcuts_org_scope_idx" ON "prompt_shortcuts" USING btree ("organization_id","scope");--> statement-breakpoint
CREATE INDEX "prompt_shortcuts_user_idx" ON "prompt_shortcuts" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "prompt_shortcut_select" ON "prompt_shortcuts" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id = (SELECT current_setting(
  'app.organization_id', true
)) AND (scope = 'team' OR user_id = (SELECT current_setting(
  'app.user_id', true
)))
));--> statement-breakpoint
CREATE POLICY "prompt_shortcut_insert" ON "prompt_shortcuts" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id = (SELECT current_setting(
  'app.organization_id', true
)) AND user_id = (SELECT current_setting(
  'app.user_id', true
))
));--> statement-breakpoint
CREATE POLICY "prompt_shortcut_update" ON "prompt_shortcuts" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id = (SELECT current_setting(
  'app.organization_id', true
)) AND (scope = 'team' OR user_id = (SELECT current_setting(
  'app.user_id', true
)))
));--> statement-breakpoint
CREATE POLICY "prompt_shortcut_delete" ON "prompt_shortcuts" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id = (SELECT current_setting(
  'app.organization_id', true
)) AND (scope = 'team' OR user_id = (SELECT current_setting(
  'app.user_id', true
)))
));