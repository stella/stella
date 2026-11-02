import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-population-projection-activity-idx",
  revision: 2,
  type: "indexes",
  values: [
    {
      name: "case_law_population_projection_activity_idx",
      introducedBy: "20261101022151_case_law_population_counts",
      tableName: "case_law_population_projections",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_population_projection_activity_idx" ON public."case_law_population_projections" USING btree ("country", "court", "updated_at" DESC, "source_id", "created_at") WHERE publication = 'published'`,
      definitionBody:
        "ON public.case_law_population_projections USING btree (country, court, updated_at DESC, source_id, created_at) WHERE (publication = 'published'::text)",
      isUnique: false,
    },
  ],
} satisfies OnlineMigrationEntry;
