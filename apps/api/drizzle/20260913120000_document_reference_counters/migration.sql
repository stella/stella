-- Every matter reference documents have been numbered under, with the matter
-- that owns it and how far its numbering has run. A printed stamp
-- "{reference}/{seq}.v{n}" names a matter for as long as the file exists, so a
-- reference that has numbered anything is refused to any other matter; the
-- owner column is what that refusal reads, and it survives the matter's
-- deletion as NULL so the reference stays retired rather than freed.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "document_reference_counters" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "reference" varchar(64) NOT NULL,
  "workspace_id" uuid,
  "last_value" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "document_reference_counters_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "document_reference_counters_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "document_reference_counters_org_ref_uidx"
  ON "document_reference_counters" ("organization_id","reference");--> statement-breakpoint

CREATE INDEX "document_reference_counters_workspace_idx"
  ON "document_reference_counters" ("workspace_id");--> statement-breakpoint

ALTER TABLE "document_reference_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "organization_select" ON "document_reference_counters" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "document_reference_counters" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "document_reference_counters" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "document_reference_counters" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_reference_counters" TO "stella";--> statement-breakpoint

-- Seed the ledger from the counters that already exist, so a reference already
-- numbering documents is owned from the start rather than looking free. One row
-- per matter that has a counter: the workspaces unique constraint on
-- (organization_id, reference) means no two matters share a reference, so this
-- cannot collide with the unique index above. Empty references are skipped
-- because they produce no stamp. The stamping feature has not shipped, so no
-- reference has been reused yet and the current counters are the whole history.
-- stella-migration-safety: reviewed insert-select - reads only workspaces joined to document_counters, each of which holds at most one row per matter (thousands, not millions), and writes one row per matter that has a counter; neither relation is registered as high-volume.
INSERT INTO "document_reference_counters" ("id", "organization_id", "reference", "workspace_id", "last_value")
SELECT gen_random_uuid(),
       matter."organization_id",
       matter."reference",
       matter."id",
       counter."last_value"
FROM "workspaces" matter
JOIN "document_counters" counter ON counter."workspace_id" = matter."id"
WHERE matter."reference" <> '';
