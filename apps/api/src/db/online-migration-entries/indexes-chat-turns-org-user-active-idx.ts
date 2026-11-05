import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-chat-turns-org-user-active-idx",
  revision: 1405,
  type: "indexes",
  values: [
    {
      introducedBy: "20261106001500_chat_turns_active_owner_index",
      createSql:
        'CREATE INDEX CONCURRENTLY "chat_turns_org_user_active_idx" ON public."chat_turns" USING btree ("organization_id", "user_id") WHERE "status" IN (\'accepted\', \'running\', \'awaiting-user\')',
      definitionBody:
        "ON public.chat_turns USING btree (organization_id, user_id) WHERE (status = ANY (ARRAY['accepted'::text, 'running'::text, 'awaiting-user'::text]))",
      isUnique: false,
      name: "chat_turns_org_user_active_idx",
      tableName: "chat_turns",
    },
  ],
} satisfies OnlineMigrationEntry;
