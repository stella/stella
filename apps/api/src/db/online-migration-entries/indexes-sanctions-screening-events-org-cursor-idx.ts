import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-sanctions-screening-events-org-cursor-idx",
  revision: 300,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "sanctions_screening_events_org_cursor_idx" ON public."sanctions_screening_events" USING btree ("organization_id", "created_at", "id")',
      definitionBody:
        "ON public.sanctions_screening_events USING btree (organization_id, created_at, id)",
      introducedBy: "20261003123000_sanctions_monitoring_review_index",
      isUnique: false,
      name: "sanctions_screening_events_org_cursor_idx",
      tableName: "sanctions_screening_events",
    },
  ],
} satisfies OnlineMigrationEntry;
