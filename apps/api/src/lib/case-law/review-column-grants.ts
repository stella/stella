/** Deploy this expansion before granting or requiring the procedural review capability. */
export const REVIEW_COLUMN_GRANTS_BY_RELATION = {
  case_law_decision_reviews: {
    reviewing_decision_id: "permitted",
    reviewed_decision_id: "permitted",
    reviewed_case_number: "permitted",
    reviewed_citation_key: "permitted",
    reviewed_docket_family_key: "permitted",
    reviewed_court: "permitted",
    reviewed_decision_date: "permitted",
    reviewed_sheet_number: "permitted",
    outcome: "permitted",
    source: "permitted",
    evidence_classification: "permitted",
    parser_version: "permitted",
  },
} as const;
