import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-time-entries-org-status-date-id-idx",
  revision: 340,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "time_entries_org_status_date_id_idx" ON public."time_entries" USING btree ("organization_id", "status", "date_worked", "id")',
      definitionBody:
        "ON public.time_entries USING btree (organization_id, status, date_worked, id)",
      introducedBy: "20261003122800_time_entry_activity_groups",
      isUnique: false,
      name: "time_entries_org_status_date_id_idx",
      tableName: "time_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
