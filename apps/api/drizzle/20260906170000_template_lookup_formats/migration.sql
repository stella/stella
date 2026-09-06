SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
CREATE TABLE "template_lookup_formats" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "registry" text NOT NULL,
  "name" varchar(120) NOT NULL,
  "format" varchar(2000) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "template_lookup_formats_name_nonempty" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "template_lookup_formats_format_nonempty" CHECK (length(btrim("format")) > 0)
);
--> statement-breakpoint
CREATE INDEX "template_lookup_formats_org_registry_id_idx" ON "template_lookup_formats" ("organization_id", "registry", "id");
--> statement-breakpoint
ALTER TABLE "template_lookup_formats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_select" ON "template_lookup_formats" FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "template_lookup_formats" FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_update" ON "template_lookup_formats" FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "template_lookup_formats" FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
