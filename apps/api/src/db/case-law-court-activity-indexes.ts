/**
 * The two indexes the per-court activity read rides, one per lateral: the
 * court's newest row by `updated_at`, and its arrivals as a `created_at`
 * range. They stay separate because a reparse rewrites `updated_at` across a
 * court, so no `updated_at` order can bound the arrivals.
 */
export const COURT_ACTIVITY_LATEST_INDEX = {
  name: "case_law_population_projection_activity_idx",
  introducedBy: "20261101022151_case_law_population_counts",
  tableName: "case_law_population_projections",
  createSql: `CREATE INDEX CONCURRENTLY "case_law_population_projection_activity_idx" ON public."case_law_population_projections" USING btree ("country", "court", "updated_at" DESC, "source_id", "created_at") WHERE publication = 'published'`,
  definitionBody:
    "ON public.case_law_population_projections USING btree (country, court, updated_at DESC, source_id, created_at) WHERE (publication = 'published'::text)",
  isUnique: false,
} as const;

export const COURT_ACTIVITY_ARRIVALS_INDEX = {
  name: "case_law_population_projection_arrivals_idx",
  introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
  tableName: "case_law_population_projections",
  createSql: `CREATE INDEX CONCURRENTLY "case_law_population_projection_arrivals_idx" ON public."case_law_population_projections" USING btree ("country", "court", "created_at", "source_id") WHERE publication = 'published'`,
  definitionBody:
    "ON public.case_law_population_projections USING btree (country, court, created_at, source_id) WHERE (publication = 'published'::text)",
  isUnique: false,
} as const;
