import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

import { SYNTHETIC_SESSION_PREFIX } from "./constants";

export const MONITORING_SESSION_INDEXES = [
  {
    createSql: `CREATE INDEX CONCURRENTLY "session_monitoring_id_idx" ON public."session" USING btree ("id") WHERE "id" LIKE '${SYNTHETIC_SESSION_PREFIX}%'`,
    definitionBody: `ON public.session USING btree (id) WHERE (id ~~ '${SYNTHETIC_SESSION_PREFIX}%'::text)`,
    isUnique: false,
    name: "session_monitoring_id_idx",
    tableName: "session",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "folio_collab_room_tokens_source_session_idx" ON public."folio_collab_room_tokens" USING btree ("source_session_id") WHERE "source_session_id" IS NOT NULL',
    definitionBody:
      "ON public.folio_collab_room_tokens USING btree (source_session_id) WHERE (source_session_id IS NOT NULL)",
    isUnique: false,
    name: "folio_collab_room_tokens_source_session_idx",
    tableName: "folio_collab_room_tokens",
  },
] as const satisfies readonly (RequiredMigrationIndex & {
  createSql: string;
})[];
