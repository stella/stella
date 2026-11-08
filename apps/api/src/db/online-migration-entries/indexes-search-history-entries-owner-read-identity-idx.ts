import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-search-history-entries-owner-read-identity-idx",
  revision: 1422,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql: `CREATE INDEX CONCURRENTLY "search_history_entries_owner_read_identity_idx" ON public."search_history_entries" (organization_id, user_id, kind, COALESCE(base_lookup_key, lookup_key), country, last_used_at, id)`,
      definitionBody:
        "ON public.search_history_entries USING btree (organization_id, user_id, kind, COALESCE(base_lookup_key, lookup_key), country, last_used_at, id)",
      isUnique: false,
      name: "search_history_entries_owner_read_identity_idx",
      tableName: "search_history_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
