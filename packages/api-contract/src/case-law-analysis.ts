/**
 * Why the decision analysis read answers `error` without a failed run behind
 * it: the server will not make an analysis of this decision at all. A failed
 * run answers with one of `ANALYSIS_FAILURE_CODES` (`@stll/legal-ast`)
 * instead, the codes its persisted record carries.
 */
export const CASE_LAW_ANALYSIS_UNAVAILABLE_CODES = [
  "decision_not_found",
  "document_unparseable",
  "language_unsupported",
  "analysis_unavailable",
] as const;

export type CaseLawAnalysisUnavailableCode =
  (typeof CASE_LAW_ANALYSIS_UNAVAILABLE_CODES)[number];
