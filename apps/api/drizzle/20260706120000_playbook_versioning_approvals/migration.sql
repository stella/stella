SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD COLUMN "approved_by" text;--> statement-breakpoint
CREATE TABLE "playbook_definition_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"playbook_definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"scope" jsonb,
	"positions" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playbook_definition_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD CONSTRAINT "playbook_definitions_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;--> statement-breakpoint
ALTER TABLE "playbook_definition_versions" ADD CONSTRAINT "playbook_def_versions_def_fk" FOREIGN KEY ("playbook_definition_id","organization_id") REFERENCES "playbook_definitions"("id","organization_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "playbook_definition_versions" ADD CONSTRAINT "playbook_def_versions_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_def_versions_def_version_uidx" ON "playbook_definition_versions" USING btree ("playbook_definition_id","version");--> statement-breakpoint
CREATE INDEX "playbook_def_versions_organization_id_idx" ON "playbook_definition_versions" USING btree ("organization_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "playbook_definition_versions" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "playbook_definition_versions" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "playbook_definition_versions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "playbook_definition_versions" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "playbook_definition_versions" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
