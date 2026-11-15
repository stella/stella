import type { OnlineMigrationEntry } from "../online-migration-entry";
import { CHAT_TURN_HANDED_OVER_UNIQUE_INDEXES } from "../online-unique-indexes";

/**
 * The three chat turn indexes whose predicate lists the unsettled statuses,
 * rebuilt to cover `handed-over` under new names. The old ones are dropped
 * by a later release, once these are valid everywhere.
 */
export default {
  id: "indexes-chat-turns-handed-over-indexes",
  revision: 1468,
  type: "indexes",
  values: [
    ...CHAT_TURN_HANDED_OVER_UNIQUE_INDEXES,
    {
      introducedBy: "20261116000000_chat_turns_handed_over",
      createSql:
        'CREATE INDEX CONCURRENTLY "chat_turns_org_user_active_v2_idx" ON public."chat_turns" USING btree ("organization_id", "user_id") WHERE "status" IN (\'accepted\', \'running\', \'awaiting-user\', \'handed-over\')',
      definitionBody:
        "ON public.chat_turns USING btree (organization_id, user_id) WHERE (status = ANY (ARRAY['accepted'::text, 'running'::text, 'awaiting-user'::text, 'handed-over'::text]))",
      isUnique: false,
      name: "chat_turns_org_user_active_v2_idx",
      tableName: "chat_turns",
    },
    {
      introducedBy: "20261116000000_chat_turns_handed_over",
      createSql:
        'CREATE INDEX CONCURRENTLY "chat_turns_org_active_lease_v2_idx" ON public."chat_turns" USING btree ("organization_id", "status", "lease_expires_at", "id") WHERE "status" IN (\'accepted\', \'running\', \'handed-over\')',
      definitionBody:
        "ON public.chat_turns USING btree (organization_id, status, lease_expires_at, id) WHERE (status = ANY (ARRAY['accepted'::text, 'running'::text, 'handed-over'::text]))",
      isUnique: false,
      name: "chat_turns_org_active_lease_v2_idx",
      tableName: "chat_turns",
    },
  ],
} satisfies OnlineMigrationEntry;
