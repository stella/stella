import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-chat-run-log-entries-text-open-idx",
  revision: 30,
  type: "indexes",
  values: [
    {
      name: "chat_run_log_entries_text_open_idx",
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      tableName: "chat_run_log_entries",
      isUnique: false,
      createSql:
        "CREATE INDEX CONCURRENTLY \"chat_run_log_entries_text_open_idx\" ON public.chat_run_log_entries (organization_id, run_id, text_boundary_initialization, text_message_end_seq, seq) WHERE (chunk->>'type' = 'TEXT_MESSAGE_START' OR (chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND chunk ? 'role'))",
      definitionBody:
        "ON public.chat_run_log_entries USING btree (organization_id, run_id, text_boundary_initialization, text_message_end_seq, seq) WHERE (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_START'::text) OR (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_CHUNK'::text) AND (chunk ? 'role'::text)))",
    },
  ],
} satisfies OnlineMigrationEntry;
