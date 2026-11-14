import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-corpus-index-projection-intents-proof-idx",
  revision: 1460,
  type: "indexes",
  values: [
    {
      introducedBy: "20261114190000_corpus_projection_durable_commit",
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_proof_idx" ON public."corpus_index_projection_intents" USING btree ("family", "generation", "index_id", "append_publish_barrier_at") WHERE "status" = 'append_committed'`,
      definitionBody:
        "ON public.corpus_index_projection_intents USING btree (family, generation, index_id, append_publish_barrier_at) WHERE (status = 'append_committed'::text)",
      isUnique: false,
      name: "corpus_index_projection_intents_proof_idx",
      tableName: "corpus_index_projection_intents",
    },
  ],
} satisfies OnlineMigrationEntry;
