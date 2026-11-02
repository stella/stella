import {
  CHAT_CONTENT_V3_REPAIR,
  CHAT_CONTENT_V3_SOURCES,
} from "../chat-content-v3-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-chat-content-v3-pending",
  revision: 120,
  type: "indexes",
  values: [
    ...Object.values(CHAT_CONTENT_V3_SOURCES).map(({ table: tableName }) => ({
      createSql: `CREATE INDEX CONCURRENTLY "${tableName}_content_v3_pending_idx" ON public."${tableName}" (id) WHERE (content -> 'version') IS DISTINCT FROM '3'::jsonb`,
      definitionBody: `ON public.${tableName} USING btree (id) WHERE ((content -> 'version'::text) IS DISTINCT FROM '3'::jsonb)`,
      introducedBy: CHAT_CONTENT_V3_REPAIR.introducedBy,
      isUnique: false,
      name: `${tableName}_content_v3_pending_idx`,
      tableName,
    })),
  ],
} satisfies OnlineMigrationEntry;
