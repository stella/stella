import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-invoice-lines-workspace-organization-idx",
  revision: 370,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "invoice_lines_workspace_organization_idx" ON public."invoice_lines" USING btree (workspace_id, organization_id)',
      definitionBody:
        "ON public.invoice_lines USING btree (workspace_id, organization_id)",
      isUnique: false,
      name: "invoice_lines_workspace_organization_idx",
      tableName: "invoice_lines",
    },
  ],
} satisfies OnlineMigrationEntry;
