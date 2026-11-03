import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-time-entries-approval-queue-idx",
  revision: 350,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "time_entries_approval_queue_idx" ON public."time_entries" USING btree ("organization_id", "approver_user_id", "status", "date_worked", "id") WHERE "status" = \'draft\'',
      definitionBody:
        "ON public.time_entries USING btree (organization_id, approver_user_id, status, date_worked, id) WHERE (status = 'draft'::text)",
      introducedBy: "20261003122700_time_entry_approval_queue",
      isUnique: false,
      name: "time_entries_approval_queue_idx",
      tableName: "time_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
