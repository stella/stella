import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-corpus-index-projection-intents-unproven-idx",
  revision: 1461,
  type: "indexes",
  values: [
    {
      introducedBy: "20261114200000_corpus_projection_unproven_bytes",
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_unproven_idx" ON public."corpus_index_projection_intents" USING btree ("family", "generation", "index_id", "append_publish_barrier_at") WHERE "status" IN ('append_started','append_committed')`,
      definitionBody:
        "ON public.corpus_index_projection_intents USING btree (family, generation, index_id, append_publish_barrier_at) WHERE (status = ANY (ARRAY['append_started'::text, 'append_committed'::text]))",
      isUnique: false,
      name: "corpus_index_projection_intents_unproven_idx",
      tableName: "corpus_index_projection_intents",
    },
  ],
} satisfies OnlineMigrationEntry;
