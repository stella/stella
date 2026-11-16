import type { OnlineMigrationEntry } from "../online-migration-entry";

const INTRODUCED_BY = "20261116020000_corpus_projection_fault_immutable";

export default {
  id: "indexes-corpus-projection-route-in-flight",
  revision: 1471,
  type: "indexes",
  values: [
    {
      name: "corpus_index_projection_intents_route_in_flight_idx",
      introducedBy: INTRODUCED_BY,
      tableName: "corpus_index_projection_intents",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_route_in_flight_idx" ON public.corpus_index_projection_intents (family, generation, index_id) WHERE (status = ANY (ARRAY['append_started'::text, 'append_committed'::text]))`,
      definitionBody: `ON public.corpus_index_projection_intents USING btree (family, generation, index_id) WHERE (status = ANY (ARRAY['append_started'::text, 'append_committed'::text]))`,
    },
  ],
} satisfies OnlineMigrationEntry;
