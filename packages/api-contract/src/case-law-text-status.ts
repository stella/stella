/** Full-text lifecycle; publisher absence always carries its own evidence. */
export const CASE_LAW_TEXT_STATUS = {
  STORED: "stored",
  PUBLISHER_HAS_NO_TEXT: "publisher_has_no_text",
  FETCH_PENDING: "fetch_pending",
  FETCH_FAILED: "fetch_failed",
  METADATA_ONLY_BY_SOURCE: "metadata_only_by_source",
} as const;

export type CaseLawTextStatus =
  (typeof CASE_LAW_TEXT_STATUS)[keyof typeof CASE_LAW_TEXT_STATUS];
