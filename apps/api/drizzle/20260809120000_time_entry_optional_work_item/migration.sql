SET lock_timeout = '1s';
-- stella-migration-safety: reviewed destructive-change - this deployment replaces the legacy work-item name and workspace-only policies atomically; rollback restores the prior names and policies with the matching application revision.
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "time_entries" RENAME COLUMN "matter_id" TO "work_item_id";
--> statement-breakpoint
-- squawk-ignore ban-drop-not-null -- Matter-level time entries intentionally have no work-item context.
ALTER TABLE "time_entries" ALTER COLUMN "work_item_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "time_entries"
  RENAME CONSTRAINT "time_entries_matter_id_entities_id_fkey"
  TO "time_entries_work_item_id_entities_id_fkey";
--> statement-breakpoint
ALTER TABLE "time_entries"
  DROP CONSTRAINT "time_entries_work_item_id_entities_id_fkey";
--> statement-breakpoint
ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_work_item_workspace_fk"
  FOREIGN KEY ("work_item_id", "workspace_id")
  REFERENCES "entities" ("id", "workspace_id")
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "workspaces" ("id", "organization_id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER INDEX "time_entries_ws_matter_status_idx"
  RENAME TO "time_entries_ws_work_item_status_idx";
--> statement-breakpoint
DROP POLICY "workspace_select" ON "time_entries";
--> statement-breakpoint
DROP POLICY "workspace_insert" ON "time_entries";
--> statement-breakpoint
DROP POLICY "workspace_update" ON "time_entries";
--> statement-breakpoint
DROP POLICY "workspace_delete" ON "time_entries";
--> statement-breakpoint
CREATE POLICY "time_entries_workspace_select" ON "time_entries"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (
    (
      "workspace_id" = ANY(
        COALESCE(
          NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      OR "workspace_id" IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    )
    AND "organization_id" = (SELECT current_setting('app.organization_id', true))
  );
--> statement-breakpoint
CREATE POLICY "time_entries_workspace_insert" ON "time_entries"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (
    (
      "workspace_id" = ANY(
        COALESCE(
          NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      OR "workspace_id" IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    )
    AND "organization_id" = (SELECT current_setting('app.organization_id', true))
  );
--> statement-breakpoint
CREATE POLICY "time_entries_workspace_update" ON "time_entries"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (
    (
      "workspace_id" = ANY(
        COALESCE(
          NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      OR "workspace_id" IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    )
    AND "organization_id" = (SELECT current_setting('app.organization_id', true))
  );
--> statement-breakpoint
CREATE POLICY "time_entries_workspace_delete" ON "time_entries"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (
    (
      "workspace_id" = ANY(
        COALESCE(
          NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      OR "workspace_id" IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    )
    AND "organization_id" = (SELECT current_setting('app.organization_id', true))
  );
