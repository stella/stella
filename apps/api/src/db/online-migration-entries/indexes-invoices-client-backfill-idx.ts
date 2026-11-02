import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-invoices-client-backfill-idx",
  revision: 410,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "invoices_client_backfill_idx" ON public."invoices" USING btree (id) WHERE client_id IS NULL AND workspace_id IS NOT NULL',
      definitionBody:
        "ON public.invoices USING btree (id) WHERE ((client_id IS NULL) AND (workspace_id IS NOT NULL))",
      isUnique: false,
      name: "invoices_client_backfill_idx",
      tableName: "invoices",
    },
  ],
} satisfies OnlineMigrationEntry;
