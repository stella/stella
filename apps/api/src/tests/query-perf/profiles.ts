export const QUERY_PERF_PROFILES = ["current", "growth"] as const;
export type QueryPerfProfileId = (typeof QUERY_PERF_PROFILES)[number];
