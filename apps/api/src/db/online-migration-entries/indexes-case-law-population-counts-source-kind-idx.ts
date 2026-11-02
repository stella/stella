import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-population-counts-source-kind-idx",
  revision: 3,
  type: "indexes",
  values: [
    {
      name: "case_law_population_counts_source_kind_idx",
      introducedBy: "20261101022151_case_law_population_counts",
      tableName: "case_law_population_counts",
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_population_counts_source_kind_idx" ON public."case_law_population_counts" USING btree ("source_id", "kind", "value", "total")',
      definitionBody:
        "ON public.case_law_population_counts USING btree (source_id, kind, value, total)",
      isUnique: false,
    },
  ],
} satisfies OnlineMigrationEntry;
