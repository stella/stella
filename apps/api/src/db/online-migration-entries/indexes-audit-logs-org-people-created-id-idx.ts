import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-audit-logs-org-people-created-id-idx",
  revision: 755,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "audit_logs_org_people_created_id_idx" ON public."audit_logs" USING btree ("organization_id", "created_at", "id") WHERE "performer_type" <> \'service\'',
      definitionBody:
        "ON public.audit_logs USING btree (organization_id, created_at, id) WHERE (performer_type <> 'service'::text)",
      isUnique: false,
      name: "audit_logs_org_people_created_id_idx",
      tableName: "audit_logs",
    },
  ],
} satisfies OnlineMigrationEntry;
