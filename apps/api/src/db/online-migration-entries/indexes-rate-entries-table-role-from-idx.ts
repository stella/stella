import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-rate-entries-table-role-from-idx",
  revision: 320,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "rate_entries_table_role_from_idx" ON public."rate_entries" USING btree ("rate_table_id", "role", "effective_from")',
      definitionBody:
        "ON public.rate_entries USING btree (rate_table_id, role, effective_from)",
      introducedBy: "20261003123000_billing_role_index",
      isUnique: false,
      name: "rate_entries_table_role_from_idx",
      tableName: "rate_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
