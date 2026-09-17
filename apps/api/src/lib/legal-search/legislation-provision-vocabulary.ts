/**
 * The closed vocabulary a batch provision read answers each of its entries
 * in.
 *
 * Here rather than beside the tool because a projection declares it too, and
 * shared API lib code may not import a handler or MCP slice.
 */
export const PROVISION_STATUS = {
  /** The entry that carries wording. */
  found: "found",
  /** No work in the corpus has that ELI. */
  notFound: "not_found",
  /** The work exists; no consolidation of it covers the requested date. */
  uncoveredDate: "uncovered_date",
  /** The consolidation exists; it carries no block under that anchor. */
  provisionNotFound: "provision_not_found",
  /** The source permits displaying the wording but bars derived AI use. */
  textWithheld: "text_withheld",
  /** The entry itself did not parse, so nothing was looked up for it. */
  invalid: "invalid",
} as const;

/**
 * Why an entry carries no wording, given an entry that parsed. Four distinct
 * answers because the next call differs: an unknown ELI is a search, a date no
 * consolidation covers is a different date, an anchor the consolidation does
 * not carry is a different anchor, and a source that bars derived AI use will
 * never answer whatever the caller changes.
 *
 * `invalid` is not here: it carries the entry's own issues instead of a
 * subject, because the subject is what failed to parse.
 */
export const PROVISION_ABSENCE_STATUSES = [
  PROVISION_STATUS.notFound,
  PROVISION_STATUS.uncoveredDate,
  PROVISION_STATUS.provisionNotFound,
  PROVISION_STATUS.textWithheld,
] as const;

/** Derived, so the outcome list and the branch lists cannot drift apart. */
export const PROVISION_READ_STATUSES = [
  PROVISION_STATUS.found,
  ...PROVISION_ABSENCE_STATUSES,
  PROVISION_STATUS.invalid,
] as const;
