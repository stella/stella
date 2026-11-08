/** Tenant profiles: document search under row security, at two sizes. */
export const QUERY_PERF_PROFILES = ["small", "growth"] as const;
export type QueryPerfTenantProfileId = (typeof QUERY_PERF_PROFILES)[number];
/** Independent clone names isolate the corpus and redaction measurement suites. */
export type QueryPerfProfileId =
  QueryPerfTenantProfileId | "corpus" | "redaction";

export const queryPerfDatabaseName = (profileId: QueryPerfProfileId) =>
  `stella_query_perf_${profileId}`;
