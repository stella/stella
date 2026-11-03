import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-invoices-ws-original-idx",
  revision: 430,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "invoices_ws_original_idx" ON public."invoices" USING btree ("workspace_id", "original_invoice_id")',
      definitionBody:
        "ON public.invoices USING btree (workspace_id, original_invoice_id)",
      introducedBy: "20261003122400_invoice_document_types",
      isUnique: false,
      name: "invoices_ws_original_idx",
      tableName: "invoices",
    },
  ],
} satisfies OnlineMigrationEntry;
