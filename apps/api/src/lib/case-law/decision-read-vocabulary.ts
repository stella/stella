/**
 * The closed vocabulary a batch decision read answers each of its entries in.
 *
 * Here rather than beside the tool because a projection declares it too, and
 * shared API lib code may not import a handler or MCP slice.
 *
 * There is no `restricted` outcome on purpose. The publication gate
 * (`public-subject.ts`) resolves a decision outside the public list, or from a
 * source that may not be redistributed, to the same null a missing row
 * resolves to: naming it would tell a caller that a decision it may not read
 * exists. A source that permits display but bars derived AI use is a different
 * matter and still answers `found`, with `textWithheldReason` in place of the
 * text.
 */
export const DECISION_READ_STATUS = {
  /** The entry that carries the decision. */
  found: "found",
  /** No decision the public may read has that id. */
  notFound: "not_found",
  /**
   * The publisher document has not been fetched yet and this call's fetch
   * budget was spent on earlier entries.
   */
  pending: "pending",
} as const;

/**
 * Why an entry carries no decision. Two distinct answers because the next
 * call differs: an unknown id is a search, a pending document is the same
 * read again on its own.
 */
export const DECISION_READ_ABSENCE_STATUSES = [
  DECISION_READ_STATUS.notFound,
  DECISION_READ_STATUS.pending,
] as const;
