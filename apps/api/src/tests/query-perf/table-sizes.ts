/**
 * Production size classes for tables deliberately populated by this fixture.
 * Any relation absent from this declaration is treated as large by the plan
 * analyzer, so adding a table cannot silently make a sequential scan legal.
 */
export const QUERY_PERF_TABLE_SIZES = {
  // The court registry: patterns per country, read whole into the weight cache.
  case_law_court_weights: "small",
  // One row per source, keyed by source_id.
  case_law_source_arrivals: "small",
  // The key primary key and key=global CHECK permit exactly one revision row.
  case_law_provision_admission: "small",
  case_law_provision_extraction_scopes: "small",
  // The name primary key and CHECK allow only scope-bootstrap and state-seed.
  case_law_provision_repair_cursors: "small",
  case_law_provision_scope_transitions: "small",
  case_law_sources: "small",
  // Source/country/court/year populations grow with the registry, not corpus rows.
  case_law_population_counts: "small",
  case_law_population_seed_state: "small",
  case_law_population_projections: "large",
  // One row per country-month or broad invalidation target currently being retired.
  case_law_sitemap_drain_progress: "small",
  // The slot=0 primary-key/check contract permits exactly one discovery cursor.
  case_law_sitemap_refresh_cursor: "small",
  corpus_index_generations: "small",
  corpus_index_jurisdiction_serving: "small",
  corpus_index_projection_intents: "large",
  corpus_index_projection_states: "large",
  // One checkpoint row per named backfill.
  database_backfill_states: "small",
  entities: "large",
  entity_versions: "large",
  legislation_documents: "large",
  legislation_sources: "small",
  search_documents: "large",
  workspace_members: "large",
  workspaces: "large",
} as const satisfies Record<string, "large" | "small">;

/**
 * System catalogs a measured statement reads, by size class. They are not
 * schema tables, so they are declared apart from the fixture's tables.
 */
const QUERY_PERF_CATALOG_SIZES = {
  // One row per database in the cluster; the load governor's indicator read.
  pg_database: "small",
} as const satisfies Record<string, "large" | "small">;

const queryPerfTableSizesByName = new Map([
  ...Object.entries(QUERY_PERF_TABLE_SIZES),
  ...Object.entries(QUERY_PERF_CATALOG_SIZES),
]);

export const isLargeQueryPerfRelation = (relation: string) =>
  queryPerfTableSizesByName.get(relation) !== "small";
