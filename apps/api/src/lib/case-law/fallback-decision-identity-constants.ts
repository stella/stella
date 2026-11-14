// parser-output-unchanged: fallback storage index names and key prefixes do not change parsed decision output.
// Shared with schema construction; no parser, payload or connection initialization.
export const FALLBACK_DECISION_IDENTITY_PREFIX = "case-number:v2:";

/** The migration whose fallback columns the online fallback indexes cover. */
export const FALLBACK_DECISION_IDENTITY_MIGRATION =
  "20261114200000_case_law_fallback_identity";
