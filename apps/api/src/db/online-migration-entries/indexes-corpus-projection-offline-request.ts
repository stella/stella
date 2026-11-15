import type { OnlineMigrationEntry } from "../online-migration-entry";

const INTRODUCED_BY = "20261115130000_corpus_projection_offline_delivery";

export default {
  id: "indexes-corpus-projection-offline-request",
  revision: 1467,
  type: "indexes",
  values: [
    {
      name: "corpus_index_projection_intents_append_request_idx",
      introducedBy: INTRODUCED_BY,
      tableName: "corpus_index_projection_intents",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_append_request_idx" ON public.corpus_index_projection_intents (append_request_id) WHERE (append_request_id IS NOT NULL)`,
      definitionBody: `ON public.corpus_index_projection_intents USING btree (append_request_id) WHERE (append_request_id IS NOT NULL)`,
    },
  ],
} satisfies OnlineMigrationEntry;
