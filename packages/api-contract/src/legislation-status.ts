/**
 * Lifecycle of a legislative text at a point in time, shared by the API and
 * clients. One declaration so the database CHECK, the reader's badge and any
 * other renderer cannot drift: a value added here fails every consumer that
 * has not decided how to show it.
 */
export const LEGISLATION_DOCUMENT_STATUSES = [
  "current",
  "historical",
  "repealed",
  "draft",
] as const;

export type LegislationDocumentStatus =
  (typeof LEGISLATION_DOCUMENT_STATUSES)[number];

export const isLegislationDocumentStatus = (
  value: unknown,
): value is LegislationDocumentStatus =>
  typeof value === "string" &&
  LEGISLATION_DOCUMENT_STATUSES.some((status) => status === value);

/**
 * Whether a listed Work still applies, read from the one wording a statute
 * listing shows per Work: the latest one that opened on or before the listing
 * date. `in-force`: that wording still applies on the date. `ended`: its
 * window closed on or before the date and no later wording opened, so the
 * Work was repealed or expired; the corpus does not say which.
 */
export const LEGISLATION_LIST_VALIDITIES = ["in-force", "ended"] as const;

export type LegislationListValidity =
  (typeof LEGISLATION_LIST_VALIDITIES)[number];
