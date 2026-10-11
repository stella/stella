/** Closed set; persisted, so a CHECK constraint mirrors it in the schema. */
export const CITATION_KIND = {
  PRECEDENT: "precedent",
  PROCEDURAL: "procedural",
} as const;

export type CitationKind = (typeof CITATION_KIND)[keyof typeof CITATION_KIND];

/** The same values as a list, for the column's `enum` and the CHECK. */
export const CITATION_KINDS = [
  CITATION_KIND.PRECEDENT,
  CITATION_KIND.PROCEDURAL,
] as const;
