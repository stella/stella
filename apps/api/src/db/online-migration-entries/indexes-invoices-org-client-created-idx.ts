import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-invoices-org-client-created-idx",
  revision: 380,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "invoices_org_client_created_idx" ON public."invoices" USING btree (organization_id, client_id, created_at, id)',
      definitionBody:
        "ON public.invoices USING btree (organization_id, client_id, created_at, id)",
      isUnique: false,
      name: "invoices_org_client_created_idx",
      tableName: "invoices",
    },
  ],
} satisfies OnlineMigrationEntry;
