/**
 * Why the decision analysis read answers `error` without a failed run behind
 * it: the server will not make an analysis of this decision at all.
 */
export const CASE_LAW_ANALYSIS_UNAVAILABLE_CODES = [
  "decision_not_found",
  "document_unparseable",
  "language_unsupported",
  "analysis_unavailable",
] as const;

export type CaseLawAnalysisUnavailableCode =
  (typeof CASE_LAW_ANALYSIS_UNAVAILABLE_CODES)[number];

/**
 * Why the reader's last run ended without an analysis, as the reader is told:
 * the answer arrived incomplete (cut off, unparseable, or not the requested
 * structure), the run outlived its deadline, the provider refused the call
 * (rejected key, billing, quota, retired model), the provider was
 * unavailable, or something else failed.
 */
export const CASE_LAW_ANALYSIS_FAILURE_CODES = [
  "answer_incomplete",
  "timed_out",
  "provider_refused",
  "provider_unavailable",
  "failed",
] as const;

export type CaseLawAnalysisFailureCode =
  (typeof CASE_LAW_ANALYSIS_FAILURE_CODES)[number];

/** Whose AI key a failed run called the provider with. */
export const CASE_LAW_ANALYSIS_KEY_SOURCES = [
  "organization",
  "platform",
] as const;

export type CaseLawAnalysisKeySource =
  (typeof CASE_LAW_ANALYSIS_KEY_SOURCES)[number];
