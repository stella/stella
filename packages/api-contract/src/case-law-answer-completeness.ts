export const CASE_LAW_ANSWER_SURFACE = {
  analysis: "analysis",
  research: "research",
  search: "search",
} as const;

export type CaseLawAnswerSurface =
  (typeof CASE_LAW_ANSWER_SURFACE)[keyof typeof CASE_LAW_ANSWER_SURFACE];

export const CASE_LAW_INCOMPLETE_REASON = {
  analysis: ["deadline", "incomplete_output", "invalid_output"],
  research: [
    "cited_passage_unknown",
    "passage_budget",
    "passage_duplicate",
    "passage_invalid",
    "passage_truncated",
    "retrieved_passage_invalid",
  ],
  search: [
    "facets_unavailable",
    "highlight_missing",
    "identity_row_dropped",
    "pagination_truncated",
    "rehydration_row_dropped",
    "snippet_missing",
  ],
} as const satisfies Record<CaseLawAnswerSurface, readonly string[]>;

export type CaseLawIncompleteReason<TSurface extends CaseLawAnswerSurface> =
  (typeof CASE_LAW_INCOMPLETE_REASON)[TSurface][number];

export type CaseLawIncompleteAnswerEvent = {
  [TSurface in CaseLawAnswerSurface]: {
    surface: TSurface;
    reason: CaseLawIncompleteReason<TSurface>;
    count: number;
  };
}[CaseLawAnswerSurface];
