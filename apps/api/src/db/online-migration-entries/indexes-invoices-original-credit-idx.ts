import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-invoices-original-credit-idx",
  revision: 1489,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      // The credit notes of one original, for the amount still due on it.
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "invoices_original_credit_idx" ON public."invoices" USING btree ("original_invoice_id", "organization_id") WHERE "original_invoice_id" IS NOT NULL',
      definitionBody:
        "ON public.invoices USING btree (original_invoice_id, organization_id) WHERE (original_invoice_id IS NOT NULL)",
      isUnique: false,
      name: "invoices_original_credit_idx",
      tableName: "invoices",
    },
  ],
} satisfies OnlineMigrationEntry;
