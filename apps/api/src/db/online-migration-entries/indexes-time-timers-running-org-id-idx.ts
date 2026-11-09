import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-time-timers-running-org-id-idx",
  revision: 600,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "time_timers_running_org_id_idx" ON public."time_timers" USING btree ("organization_id", "id") WHERE "state" = \'running\'',
      definitionBody:
        "ON public.time_timers USING btree (organization_id, id) WHERE (state = 'running'::text)",
      introducedBy: "20261003122600_timer_admin_stop",
      isUnique: false,
      name: "time_timers_running_org_id_idx",
      tableName: "time_timers",
    },
  ],
} satisfies OnlineMigrationEntry;
