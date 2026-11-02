import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-report-exports-workspace-requester-created-idx",
  revision: 650,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON public."report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")',
      definitionBody:
        "ON public.report_exports USING btree (workspace_id, requested_by, created_at, id)",
      introducedBy: "20260717160000_report_export_history_index",
      isUnique: false,
      name: "report_exports_workspace_requester_created_idx",
      tableName: "report_exports",
    },
  ],
} satisfies OnlineMigrationEntry;
