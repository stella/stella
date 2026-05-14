-- Allowlist counterpart to anonymization_blacklist_entries. Stores
-- canonicals the user has explicitly marked as false positives so
-- the detection pipeline can skip them. The NULL pattern matches
-- the blacklist's three-tier scope:
--   workspace_id IS NULL AND entity_id IS NULL → org-wide
--   workspace_id set, entity_id IS NULL       → workspace-wide
--   workspace_id set, entity_id set           → single document
--
-- Doc scope keys on entity_id (the file's entity) so the
-- allowlist follows the file across version cuts.

CREATE TABLE "anonymization_allowlist_entries" (
  "id" uuid PRIMARY KEY,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid,
  "entity_id" uuid,
  "label" varchar(64) NOT NULL,
  "canonical" varchar(512) NOT NULL,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anonymization_allowlist_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "anonymization_allowlist_entries_org_idx"
  ON "anonymization_allowlist_entries" ("organization_id");
--> statement-breakpoint
CREATE INDEX "anonymization_allowlist_entries_workspace_idx"
  ON "anonymization_allowlist_entries" ("workspace_id")
  WHERE "workspace_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "anonymization_allowlist_entries_entity_idx"
  ON "anonymization_allowlist_entries" ("entity_id")
  WHERE "entity_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "anonymization_allowlist_entries_org_canonical_uidx"
  ON "anonymization_allowlist_entries" ("organization_id", lower("canonical"))
  WHERE "workspace_id" IS NULL AND "entity_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "anonymization_allowlist_entries_ws_canonical_uidx"
  ON "anonymization_allowlist_entries" ("workspace_id", lower("canonical"))
  WHERE "workspace_id" IS NOT NULL AND "entity_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "anonymization_allowlist_entries_entity_canonical_uidx"
  ON "anonymization_allowlist_entries" ("entity_id", lower("canonical"))
  WHERE "entity_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "anonymization_allowlist_entries"
  ADD CONSTRAINT "anonymization_allowlist_entries_organization_id_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "anonymization_allowlist_entries"
  ADD CONSTRAINT "anonymization_allowlist_entries_workspace_id_workspaces_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "anonymization_allowlist_entries"
  ADD CONSTRAINT "anonymization_allowlist_entries_entity_id_entities_id_fkey"
  FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "anonymization_allowlist_entries"
  ADD CONSTRAINT "anonymization_allowlist_entries_created_by_user_id_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE POLICY "organization_select" ON "anonymization_allowlist_entries"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "anonymization_allowlist_entries"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_update" ON "anonymization_allowlist_entries"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "anonymization_allowlist_entries"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
-- Bootstrap migration grants table-level permissions in a single sweep;
-- new RLS-enabled tables miss that, so grant explicitly here.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "anonymization_allowlist_entries" TO stella;
