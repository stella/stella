/**
 * How the reader reached a decision page when the page should say so: the
 * value of the decision route's `match` search parameter. `file_incomplete`
 * is a docket that found one decision in a case file whose other decisions
 * the read may not have reached, so the page notes that the file may hold
 * more.
 */
export const PUBLIC_DECISION_MATCH = {
  FILE_INCOMPLETE: "file_incomplete",
} as const;
