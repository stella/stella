-- stella-migration-safety: reviewed destructive-change - the dropped index is recreated immediately below as a partial unique index on (organization_id, lower(canonical)) WHERE workspace_id IS NULL, preserving the existing org-wide uniqueness guarantee. The split into two partial indexes lets the same canonical exist per-workspace without colliding with the org-wide row; rollback is the inverse drop + recreate of the full index.

-- Adds a nullable workspace_id column to anonymization_blacklist_entries so
-- the same table can hold both org-wide entries (workspace_id IS NULL,
-- matches the existing org-settings catalog) and workspace-only entries
-- created from the new file-inspector Anonymization facet.

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
