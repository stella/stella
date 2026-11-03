import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-time-entries-submitted-queue-idx",
  revision: 360,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "time_entries_submitted_queue_idx" ON public."time_entries" USING btree ("organization_id", "approver_user_id", "date_worked", "id") WHERE "status" = \'submitted\'',
      definitionBody:
        "ON public.time_entries USING btree (organization_id, approver_user_id, date_worked, id) WHERE (status = 'submitted'::text)",
      isUnique: false,
      name: "time_entries_submitted_queue_idx",
      tableName: "time_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
