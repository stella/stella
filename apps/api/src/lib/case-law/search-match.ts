/**
 * How much of the query a search hit holds. A hit is `all_terms` when the
 * decision satisfies the strict query, and `some_terms` when it was appended
 * to a short first page because it holds only some of the query's words.
 */
export const DECISION_SEARCH_MATCHES = ["all_terms", "some_terms"] as const;

export type DecisionSearchMatch = (typeof DECISION_SEARCH_MATCHES)[number];
