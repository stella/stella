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
  "unknown",
] as const;

export type LegislationDocumentStatus =
  (typeof LEGISLATION_DOCUMENT_STATUSES)[number];

/**
 * The statuses that only say whether a version's validity window covers a
 * day. A stored one reflects the day the version was ingested, so every read
 * derives them from the stored window and today's date instead; the other
 * statuses are publisher statements and are read as stored.
 */
export const LEGISLATION_WINDOW_STATUSES = [
  "current",
  "historical",
] as const satisfies readonly LegislationDocumentStatus[];

export const isLegislationWindowStatus = (
  value: string,
): value is (typeof LEGISLATION_WINDOW_STATUSES)[number] =>
  LEGISLATION_WINDOW_STATUSES.some((status) => status === value);

export const isLegislationDocumentStatus = (
  value: unknown,
): value is LegislationDocumentStatus =>
  typeof value === "string" &&
  LEGISLATION_DOCUMENT_STATUSES.some((status) => status === value);

/**
 * Whether a listed Work still applies, read from the one wording a statute
 * listing shows per Work: the latest one that can apply and opened on or
 * before the listing date. `in-force`: that wording still applies on the
 * date. `ended`: its window closed on or before the date and no later wording
 * opened, so the Work was repealed or expired; the corpus does not say which.
 *
 * A Work none of whose versions can apply is listed by its latest version
 * instead. `never-in-force`: the publisher states that every consolidation of
 * it never took effect. `unknown`: anything short of that proof, such as
 * versions whose publisher windows are inconsistent.
 */
export const LEGISLATION_LIST_VALIDITIES = [
  "in-force",
  "ended",
  "never-in-force",
  "unknown",
] as const;

export type LegislationListValidity =
  (typeof LEGISLATION_LIST_VALIDITIES)[number];
