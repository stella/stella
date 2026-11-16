/** Tenant profiles: document search under row security, at two sizes. */
export const QUERY_PERF_PROFILES = ["small", "growth"] as const;
export type QueryPerfTenantProfileId = (typeof QUERY_PERF_PROFILES)[number];
/** The public corpus in production's shape; see `corpus-seed.ts`. */
export type QueryPerfProfileId = QueryPerfTenantProfileId | "corpus";

export const queryPerfDatabaseName = (profileId: QueryPerfProfileId) =>
  `stella_query_perf_${profileId}`;
