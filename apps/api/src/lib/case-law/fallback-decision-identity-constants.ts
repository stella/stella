// parser-output-unchanged: fallback storage index names and key prefixes do not change parsed decision output.
// Shared with schema construction; no parser, payload or connection initialization.
import { ONLINE_UNIQUE_INDEX_NAMES } from "@/api/db/online-unique-indexes";

export const FALLBACK_DECISION_IDENTITY_INDEX =
  ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_DECISIONS_SOURCE_FALLBACK_IDENTITY_IDX;
export const FALLBACK_DECISION_CONTENT_INDEX =
  ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_DECISIONS_SOURCE_FALLBACK_CONTENT_IDX;
export const FALLBACK_DECISION_IDENTITY_PREFIX = "case-number:v2:";

/** The docket-only index the fallback identity indexes replace. */
export const PREVIOUS_FALLBACK_DECISION_INDEX =
  ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_DECISIONS_SOURCE_CASE_LANG_NULL_IDX;

/** The migration whose fallback columns the online fallback indexes cover. */
export const FALLBACK_DECISION_IDENTITY_MIGRATION =
  "20261114120000_case_law_fallback_identity";
