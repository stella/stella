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
