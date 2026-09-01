/**
 * A research table is a saved case-law search a lawyer keeps working on: the
 * query it was made from, the decisions pinned into or excluded from its rows,
 * and (later) the questions asked of every row. Rows are the public corpus
 * itself, addressed by decision id; nothing about a decision is copied.
 */
export const CASE_LAW_RESEARCH_QUERY_VERSION = 1 as const;

/** How one decision deviates from what the saved query returns. */
export const CASE_LAW_RESEARCH_DISPOSITIONS = ["pinned", "excluded"] as const;

export type CaseLawResearchDisposition =
  (typeof CASE_LAW_RESEARCH_DISPOSITIONS)[number];

/**
 * The search a table re-runs for its rows. Field names are those of the
 * public decision search body, so the client can pass it straight through.
 */
export type CaseLawResearchSavedQuery = {
  version: typeof CASE_LAW_RESEARCH_QUERY_VERSION;
  query: string;
  country?: string;
  court?: string;
  dateFrom?: string;
  dateTo?: string;
  decisionType?: string;
  language?: string;
  sourceId?: string;
};
