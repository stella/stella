import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-search-history-entries-owner-country-recent-idx",
  revision: 750,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "search_history_entries_owner_country_recent_idx" ON public."search_history_entries" USING btree ("organization_id", "user_id", "country", "last_used_at", "id")',
      definitionBody:
        "ON public.search_history_entries USING btree (organization_id, user_id, country, last_used_at, id)",
      isUnique: false,
      name: "search_history_entries_owner_country_recent_idx",
      tableName: "search_history_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
