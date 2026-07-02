SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "kind" text DEFAULT 'document' NOT NULL;--> statement-breakpoint
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" text,
	"template_ref" jsonb NOT NULL,
	"view_id" uuid,
	"layout" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text NOT NULL,
	"error" text,
	"result_entity_id" uuid,
	"result_s3_key" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_view_fk" FOREIGN KEY ("view_id") REFERENCES "workspace_views"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_result_entity_fk" FOREIGN KEY ("result_entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "report_exports_workspace_created_idx" ON "report_exports" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "report_exports" TO stella;--> statement-breakpoint
CREATE POLICY "workspace_select" ON "report_exports" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "report_exports" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "report_exports" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "report_exports" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
