import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-chat-run-log-entries-message-snapshot-idx",
  revision: 10,
  type: "indexes",
  values: [
    {
      name: "chat_run_log_entries_message_snapshot_idx",
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      tableName: "chat_run_log_entries",
      isUnique: false,
      createSql:
        "CREATE INDEX CONCURRENTLY \"chat_run_log_entries_message_snapshot_idx\" ON public.chat_run_log_entries (organization_id, run_id, seq) WHERE chunk->>'type' = 'MESSAGES_SNAPSHOT'",
      definitionBody:
        "ON public.chat_run_log_entries USING btree (organization_id, run_id, seq) WHERE ((chunk ->> 'type'::text) = 'MESSAGES_SNAPSHOT'::text)",
    },
  ],
} satisfies OnlineMigrationEntry;
