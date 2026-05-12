-- Adds a nullable workspace_id column to anonymization_blacklist_entries so
-- the same table can hold both org-wide entries (workspace_id IS NULL,
-- matches the existing org-settings catalog) and workspace-only entries
-- created from the new file-inspector Anonymization facet.
--
-- The existing unique index on (organization_id, lower(canonical)) gets
-- split into two partial unique indexes: one for org-wide rows and one
-- for workspace-scoped rows. This lets the same canonical exist in
-- different workspaces without clashing with the org-wide entry.

ALTER TABLE "anonymization_blacklist_entries"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid
    REFERENCES "workspaces"("id") ON DELETE CASCADE;

DROP INDEX IF EXISTS "anonymization_blacklist_entries_org_canonical_uidx";

CREATE UNIQUE INDEX IF NOT EXISTS "anonymization_blacklist_entries_org_canonical_uidx"
  ON "anonymization_blacklist_entries" ("organization_id", lower("canonical"))
  WHERE "workspace_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "anonymization_blacklist_entries_ws_canonical_uidx"
  ON "anonymization_blacklist_entries" ("workspace_id", lower("canonical"))
  WHERE "workspace_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "anonymization_blacklist_entries_workspace_idx"
  ON "anonymization_blacklist_entries" ("workspace_id", "enabled");
