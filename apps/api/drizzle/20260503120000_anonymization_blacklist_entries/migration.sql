CREATE TABLE "anonymization_blacklist_entries" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"label" varchar(64) NOT NULL,
	"canonical" varchar(512) NOT NULL,
	"variants" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anonymization_blacklist_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "anonymization_blacklist_entries_org_enabled_idx" ON "anonymization_blacklist_entries" ("organization_id","enabled");
--> statement-breakpoint
CREATE UNIQUE INDEX "anonymization_blacklist_entries_org_canonical_uidx" ON "anonymization_blacklist_entries" ("organization_id",lower("canonical"));
--> statement-breakpoint
ALTER TABLE "anonymization_blacklist_entries" ADD CONSTRAINT "anonymization_blacklist_entries_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "anonymization_blacklist_entries" ADD CONSTRAINT "anonymization_blacklist_entries_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "anonymization_blacklist_entries" ADD CONSTRAINT "anonymization_blacklist_entries_updated_by_user_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE POLICY "organization_select" ON "anonymization_blacklist_entries" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "anonymization_blacklist_entries" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "organization_update" ON "anonymization_blacklist_entries" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "anonymization_blacklist_entries" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
