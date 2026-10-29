/**
 * Production size classes for tables deliberately populated by this fixture.
 * Any relation absent from this declaration is treated as large by the plan
 * analyzer, so adding a table cannot silently make a sequential scan legal.
 */
export const QUERY_PERF_TABLE_SIZES = {
  case_law_sources: "small",
  corpus_index_generations: "small",
  corpus_index_jurisdiction_serving: "small",
  corpus_index_projection_intents: "large",
  corpus_index_projection_states: "large",
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
export const QUERY_PERF_CATALOG_SIZES = {
  // One row per database in the cluster; the load governor's indicator read.
  pg_database: "small",
} as const satisfies Record<string, "large" | "small">;

const queryPerfTableSizesByName = new Map([
  ...Object.entries(QUERY_PERF_TABLE_SIZES),
  ...Object.entries(QUERY_PERF_CATALOG_SIZES),
]);

export const isLargeQueryPerfRelation = (relation: string) =>
  queryPerfTableSizesByName.get(relation) !== "small";
