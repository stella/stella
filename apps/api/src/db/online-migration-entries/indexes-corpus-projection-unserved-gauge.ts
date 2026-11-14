import type { OnlineMigrationEntry } from "../online-migration-entry";

const INTRODUCED_BY = "20261114210000_corpus_projection_unserved_indexes";

const DELETE_UNPROVEN_SQL =
  "(status = ANY (ARRAY['cleanup_started'::text, 'cleanup_committed'::text, 'cleanup_stalled'::text])) OR ((status = 'cleanup_pending'::text) AND (cleanup_attempts > 0))";

const ABSENT_SQL =
  "(desired_action = 'upsert'::text) AND ((applied_action = 'erase'::text) OR applied_revision_settled)";

export default {
  id: "indexes-corpus-projection-unserved-gauge",
  revision: 1461,
  type: "indexes",
  values: [
    {
      name: "corpus_index_projection_intents_delete_unproven_idx",
      introducedBy: INTRODUCED_BY,
      tableName: "corpus_index_projection_intents",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_delete_unproven_idx" ON public.corpus_index_projection_intents (family, generation, COALESCE(cleanup_started_at, updated_at), id) WHERE (${DELETE_UNPROVEN_SQL})`,
      definitionBody: `ON public.corpus_index_projection_intents USING btree (family, generation, COALESCE(cleanup_started_at, updated_at), id) WHERE (${DELETE_UNPROVEN_SQL})`,
    },
    {
      name: "corpus_index_projection_states_absent_idx",
      introducedBy: INTRODUCED_BY,
      tableName: "corpus_index_projection_states",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_states_absent_idx" ON public.corpus_index_projection_states (family, generation, entity_id) WHERE (${ABSENT_SQL})`,
      definitionBody: `ON public.corpus_index_projection_states USING btree (family, generation, entity_id) WHERE (${ABSENT_SQL})`,
    },
  ],
} satisfies OnlineMigrationEntry;
