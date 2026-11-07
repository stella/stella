import type { OnlineMigrationEntry } from "../online-migration-entry";

const NEEDS_WORK_SQL =
  "(work_status = 'repair_scheduled'::text) OR ((work_status = ANY (ARRAY['eligible'::text, 'retry_scheduled'::text])) AND ((applied_action IS NULL) OR (applied_action IS DISTINCT FROM desired_action) OR (applied_epoch IS DISTINCT FROM desired_epoch) OR ((applied_fingerprint)::text IS DISTINCT FROM (desired_fingerprint)::text) OR ((applied_index_id)::text IS DISTINCT FROM (desired_index_id)::text)))";

export default {
  id: "indexes-corpus-index-projection-states-append-route-idx",
  revision: 1416,
  type: "indexes",
  values: [
    {
      name: "corpus_index_projection_states_append_route_idx",
      introducedBy: "20261107183000_corpus_projection_revision_settled",
      tableName: "corpus_index_projection_states",
      isUnique: false,
      createSql: `CREATE INDEX CONCURRENTLY "corpus_index_projection_states_append_route_idx" ON public.corpus_index_projection_states (family, generation, desired_index_id, COALESCE(retry_not_before, updated_at), entity_id) WHERE ((${NEEDS_WORK_SQL}) AND ((applied_revision IS NULL) OR applied_revision_settled))`,
      definitionBody: `ON public.corpus_index_projection_states USING btree (family, generation, desired_index_id, COALESCE(retry_not_before, updated_at), entity_id) WHERE ((${NEEDS_WORK_SQL}) AND ((applied_revision IS NULL) OR applied_revision_settled))`,
    },
  ],
} satisfies OnlineMigrationEntry;
