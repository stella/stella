import type { OnlineMigrationEntry } from "../online-migration-entry";

const INTRODUCED_BY = "20261115130000_corpus_projection_offline_delivery";

export default {
  id: "indexes-corpus-projection-withdrawn-census",
  revision: 1466,
  type: "indexes",
  values: [
    {
      name: "corpus_index_projection_intents_withdrawn_census_idx",
      introducedBy: INTRODUCED_BY,
      tableName: "corpus_index_projection_intents",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_withdrawn_census_idx" ON public.corpus_index_projection_intents (family, generation, index_id, id) WHERE (status = 'withdrawn'::text)`,
      definitionBody: `ON public.corpus_index_projection_intents USING btree (family, generation, index_id, id) WHERE (status = 'withdrawn'::text)`,
    },
  ],
} satisfies OnlineMigrationEntry;
