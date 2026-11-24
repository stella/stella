import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-workspaces-org-all-members-idx",
  revision: 1603,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "workspaces_org_all_members_idx" ON public."workspaces" USING btree ("organization_id") WHERE "visibility" = \'all_members\'',
      definitionBody:
        "ON public.workspaces USING btree (organization_id) WHERE (visibility = 'all_members'::text)",
      isUnique: false,
      introducedBy: "20261124200000_matter_visibility",
      name: "workspaces_org_all_members_idx",
      tableName: "workspaces",
    },
  ],
} satisfies OnlineMigrationEntry;
