// parser-output-unchanged: shared reporter suffix preserves the existing citation grammar
/** Suffixes that identify case-law reporters sharing the Czech Sb. prefix. */
export const CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE = String.raw`(?:NSS|rozh\.)`;

// A lenient gazette match can leave Sb.'s optional dot in the tail when the
// reporter follows it without whitespace. Both tails identify the reporter.
export const CZE_CASE_LAW_REPORTER_TAIL_RE = new RegExp(
  String.raw`^\.? ?${CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE}(?![\p{L}\p{N}])`,
  "iu",
);
