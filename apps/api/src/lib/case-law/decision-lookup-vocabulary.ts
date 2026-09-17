/**
 * The closed vocabulary an identifier lookup answers each of its entries in.
 *
 * Here rather than beside the tool because a projection declares it too, and
 * shared API lib code may not import a handler or MCP slice.
 *
 * There is deliberately no "best match". A docket is unique to a court, not
 * to the corpus: `Pl. ÚS 33/97` names one decision, while a number a regional
 * court and an appellate court both used names two, and choosing one of them
 * would put a citation in a brief under the wrong court's name. Several
 * candidates are `ambiguous` and the caller picks.
 */
export const DECISION_LOOKUP_STATUS = {
  /** Exactly one decision in the corpus answers to the identifier. */
  found: "found",
  /** Several do, and which one is meant is the caller's decision. */
  ambiguous: "ambiguous",
  /** None does, or the identifier is not one the corpus's grammars claim. */
  notFound: "not_found",
} as const;
