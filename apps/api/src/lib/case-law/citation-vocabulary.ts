/**
 * The closed vocabularies the citation graph is read in.
 *
 * Here rather than beside the queries because a projection declares them too,
 * and shared API lib code may not import a handler slice.
 * `citation-vocabulary.test.ts` holds the treatment list and the polarity
 * domain to each other in both directions, so neither can move alone.
 */

/**
 * One side of the citation graph, seen from a decision: the decisions it
 * cites (`outgoing`) or the decisions that cite it (`incoming`). Citing is
 * not relying: the graph carries the citations that distinguish, reject or
 * depart from the cited decision alongside the ones that follow it, so only
 * `CITATION_TREATMENTS` says how a court used what it cited.
 */
export const CITATION_DIRECTIONS = ["incoming", "outgoing"] as const;
export type CitationDirection = (typeof CITATION_DIRECTIONS)[number];

/**
 * The same two sides as a reader asks for them. The graph's own vocabulary is
 * incoming/outgoing; the rename happens in `GRAPH_DIRECTION`, once, and every
 * agent-facing surface reads these names.
 */
export const CITATION_READ_DIRECTIONS = ["cites", "cited_by"] as const;
export type CitationReadDirection = (typeof CITATION_READ_DIRECTIONS)[number];

export const GRAPH_DIRECTION = {
  cites: "outgoing",
  cited_by: "incoming",
} as const satisfies Record<CitationReadDirection, CitationDirection>;

/**
 * How the citing text treats the cited decision, as the display reads it.
 *
 * `unclassified` folds a row the classifier never reached (`null`) together
 * with one it reached and could not answer (`unknown`): neither is a reading
 * of the text, so neither may pose as one. Every other stored polarity is a
 * reading and passes through by name, including `mixed`, which is the one the
 * pipeline derives: the citing decision departed from the cited one at one
 * mention and relied on it at another.
 */
export const CITATION_TREATMENTS = [
  "negative",
  "neutral",
  "positive",
  "supportive",
  "mixed",
  "unclassified",
] as const;
export type CitationTreatment = (typeof CITATION_TREATMENTS)[number];
