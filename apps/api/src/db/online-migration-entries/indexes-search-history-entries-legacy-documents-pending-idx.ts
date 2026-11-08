import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-search-history-entries-legacy-documents-pending-idx",
  revision: 1423,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql: `CREATE INDEX CONCURRENTLY "search_history_entries_legacy_documents_pending_idx" ON public."search_history_entries" (id) WHERE country IS NULL AND kind <> 'search'`,
      definitionBody:
        "ON public.search_history_entries USING btree (id) WHERE ((country IS NULL) AND (kind <> 'search'::text))",
      isUnique: false,
      name: "search_history_entries_legacy_documents_pending_idx",
      tableName: "search_history_entries",
    },
  ],
} satisfies OnlineMigrationEntry;
