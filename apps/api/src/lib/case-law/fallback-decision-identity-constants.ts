// parser-output-unchanged: fallback storage index names and key prefixes do not change parsed decision output.
// Shared with schema construction; no parser, payload or connection initialization.
export const FALLBACK_DECISION_IDENTITY_INDEX =
  "case_law_decisions_source_fallback_identity_idx";
export const FALLBACK_DECISION_CONTENT_INDEX =
  "case_law_decisions_source_fallback_content_idx";
export const FALLBACK_DECISION_IDENTITY_PREFIX = "case-number:v2:";

export const PREVIOUS_FALLBACK_DECISION_INDEX =
  "case_law_decisions_source_case_lang_null_idx";
