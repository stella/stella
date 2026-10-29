/**
 * Production size classes for tables deliberately populated by this fixture.
 * Any relation absent from this declaration is treated as large by the plan
 * analyzer, so adding a table cannot silently make a sequential scan legal.
 */
export const QUERY_PERF_TABLE_SIZES = {
  case_law_provision_extraction_scopes: "small",
  case_law_provision_scope_transitions: "small",
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
 * System catalogs a measured job reads for its database health signals. Their
 * size follows the cluster's object count, not the data, so a scan stays small.
 */
const QUERY_PERF_BOUNDED_SYSTEM_CATALOGS: ReadonlySet<string> = new Set([
  "pg_database",
]);

const queryPerfTableSizesByName = new Map(
  Object.entries(QUERY_PERF_TABLE_SIZES),
);

export const isLargeQueryPerfRelation = (relation: string) =>
  !QUERY_PERF_BOUNDED_SYSTEM_CATALOGS.has(relation) &&
  queryPerfTableSizesByName.get(relation) !== "small";
