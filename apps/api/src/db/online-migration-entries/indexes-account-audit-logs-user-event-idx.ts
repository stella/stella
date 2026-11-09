import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-account-audit-logs-user-event-idx",
  revision: 4,
  type: "indexes",
  values: [
    {
      name: "account_audit_logs_user_event_idx",
      introducedBy: "20261031213547_organization_created_audit_event",
      tableName: "account_audit_logs",
      isUnique: false,
      createSql:
        'CREATE INDEX CONCURRENTLY "account_audit_logs_user_event_idx" ON public.account_audit_logs (user_id, event_type)',
      definitionBody:
        "ON public.account_audit_logs USING btree (user_id, event_type)",
    },
  ],
} satisfies OnlineMigrationEntry;
