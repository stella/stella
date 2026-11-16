import type { OnlineMigrationEntry } from "../online-migration-entry";

const INTRODUCED_BY = "20261115220000_corpus_projection_offline_fault";

export default {
  id: "indexes-corpus-projection-offline-start",
  revision: 1470,
  type: "indexes",
  values: [
    {
      name: "corpus_index_projection_intents_offline_start_idx",
      introducedBy: INTRODUCED_BY,
      tableName: "corpus_index_projection_intents",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_offline_start_idx" ON public.corpus_index_projection_intents (family, generation, index_id, append_started_at) WHERE (append_delivery = 'offline_indexer'::text)`,
      definitionBody: `ON public.corpus_index_projection_intents USING btree (family, generation, index_id, append_started_at) WHERE (append_delivery = 'offline_indexer'::text)`,
    },
  ],
} satisfies OnlineMigrationEntry;
