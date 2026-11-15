import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-population-deltas-source-kind-idx",
  revision: 1,
  type: "indexes",
  values: [
    {
      name: "case_law_population_deltas_source_kind_idx",
      introducedBy: "20261101022151_case_law_population_counts",
      tableName: "case_law_population_deltas",
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_population_deltas_source_kind_idx" ON public."case_law_population_deltas" USING btree ("source_id", "kind", "value")',
      definitionBody:
        "ON public.case_law_population_deltas USING btree (source_id, kind, value)",
      isUnique: false,
    },
  ],
} satisfies OnlineMigrationEntry;
