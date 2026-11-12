import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-chat-threads-org-user-pinned-idx",
  revision: 1430,
  type: "indexes",
  values: [
    {
      introducedBy: "20261110160000_chat_thread_reader_state",
      createSql:
        'CREATE INDEX CONCURRENTLY "chat_threads_org_user_pinned_idx" ON public."chat_threads" USING btree ("organization_id", "user_id", "updated_at", "id") WHERE "pinned_at" IS NOT NULL',
      definitionBody:
        "ON public.chat_threads USING btree (organization_id, user_id, updated_at, id) WHERE (pinned_at IS NOT NULL)",
      isUnique: false,
      name: "chat_threads_org_user_pinned_idx",
      tableName: "chat_threads",
    },
  ],
} satisfies OnlineMigrationEntry;
