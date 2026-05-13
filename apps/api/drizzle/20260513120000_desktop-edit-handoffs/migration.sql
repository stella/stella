CREATE TABLE "desktop_edit_handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"api_base_url" text NOT NULL,
	"linked_account" jsonb,
	"force_takeover" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"desktop_session_id" uuid,
	"opened_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD CONSTRAINT "desktop_edit_handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD CONSTRAINT "desktop_edit_handoffs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD CONSTRAINT "desktop_edit_handoffs_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD CONSTRAINT "desktop_edit_handoffs_property_workspace_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD CONSTRAINT "desktop_edit_handoffs_desktop_session_id_desktop_edit_sessions_id_fk" FOREIGN KEY ("desktop_session_id") REFERENCES "desktop_edit_sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "desktop_edit_handoffs_workspace_id_idx" ON "desktop_edit_handoffs" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "desktop_edit_handoffs_expires_at_idx" ON "desktop_edit_handoffs" ("expires_at");
--> statement-breakpoint
CREATE INDEX "desktop_edit_handoffs_workspace_created_by_idx" ON "desktop_edit_handoffs" ("workspace_id","created_by");
--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_edit_handoffs_token_hash_uidx" ON "desktop_edit_handoffs" ("token_hash");
--> statement-breakpoint
CREATE POLICY "workspace_select" ON "desktop_edit_handoffs" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "desktop_edit_handoffs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_update" ON "desktop_edit_handoffs" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "desktop_edit_handoffs" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "desktop_edit_handoffs" TO stella;
