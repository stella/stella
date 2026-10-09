export const QUERY_PERF_PROFILES = ["small", "growth"] as const;
export type QueryPerfProfileId = (typeof QUERY_PERF_PROFILES)[number];

export const queryPerfDatabaseName = (profileId: QueryPerfProfileId) =>
  `stella_query_perf_${profileId}`;
