CREATE TABLE "cell_metadata" (
	"workspace_id" uuid NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cell_metadata_entity_version_id_property_id_pk" PRIMARY KEY("entity_version_id","property_id")
);
--> statement-breakpoint
ALTER TABLE "cell_metadata" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cell_metadata" ADD CONSTRAINT "cell_metadata_entity_version_id_entity_versions_id_fk" FOREIGN KEY ("entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "cell_metadata" ADD CONSTRAINT "cell_metadata_property_id_workspace_id_properties_id_workspace_id_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "cell_metadata" ADD CONSTRAINT "cell_metadata_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "cell_metadata" ADD CONSTRAINT "cell_metadata_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "cell_metadata_workspace_id_idx" ON "cell_metadata" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "cell_metadata_entity_version_id_idx" ON "cell_metadata" ("entity_version_id");
--> statement-breakpoint
CREATE POLICY "workspace_select" ON "cell_metadata" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "cell_metadata" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_update" ON "cell_metadata" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "cell_metadata" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
