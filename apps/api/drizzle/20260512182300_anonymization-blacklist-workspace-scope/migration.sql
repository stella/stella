-- stella-migration-safety: reviewed destructive-change - the dropped
-- index is immediately re-created as a partial index with the same
-- columns plus a `WHERE workspace_id IS NULL` clause, so existing
-- org-wide uniqueness coverage is preserved. The new partial index
-- splits the org-wide guarantee from the workspace-scope one so the
-- same canonical can exist in different workspaces without colliding
-- with the org-wide entry.

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
