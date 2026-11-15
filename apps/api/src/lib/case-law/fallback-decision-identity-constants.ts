// parser-output-unchanged: fallback storage index names, including the retired docket-only index, and key prefixes do not change parsed decision output.
// Shared with schema construction; no parser, payload or connection initialization.
export const FALLBACK_DECISION_IDENTITY_PREFIX = "case-number:v2:";

/** The docket-only index the fallback identity indexes replaced; the
 *  contract release retired it. */
export const PREVIOUS_FALLBACK_DECISION_INDEX =
  "case_law_decisions_source_case_lang_null_idx";

/** The migration whose fallback columns the online fallback indexes cover. */
export const FALLBACK_DECISION_IDENTITY_MIGRATION =
  "20261115150000_case_law_fallback_identity";
