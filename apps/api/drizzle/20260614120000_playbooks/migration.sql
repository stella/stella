SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"type_property_id" uuid NOT NULL,
	"type_value" varchar(1000) NOT NULL,
	"bundle" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playbooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_type_property_fk" FOREIGN KEY ("type_property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "playbooks_workspace_id_idx" ON "playbooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "playbooks_workspace_created_idx" ON "playbooks" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "playbooks" TO stella;--> statement-breakpoint
CREATE POLICY "workspace_select" ON "playbooks" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "playbooks" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "playbooks" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "playbooks" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
