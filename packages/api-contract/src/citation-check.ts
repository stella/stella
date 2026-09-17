/**
 * How a decision stands to the sentence that cites it.
 *
 * In the contract because both runtimes are total over it: the API builds one
 * criterion per relation for the model that judges, and the editor renders one
 * tone and one label per relation for the lawyer who reads the answer. Two
 * hand-kept lists would agree until a relation was added to one of them.
 */

/** The findings a judgment can return. `uncertain` is not one of them: it is
 *  what the endpoint answers when the reading did not clear its floor. */
export const CITATION_RELATIONS = [
  "supports",
  "contradicts",
  "does_not_address",
] as const;
export type CitationRelation = (typeof CITATION_RELATIONS)[number];

export const CITATION_RELATION_UNCERTAIN = "uncertain";

/** What the response reports: a judged relation, or the floor not being met. */
export type CitationRelationReading =
  | CitationRelation
  | typeof CITATION_RELATION_UNCERTAIN;

export const CITATION_RELATION_READINGS = [
  ...CITATION_RELATIONS,
  CITATION_RELATION_UNCERTAIN,
] as const satisfies readonly CitationRelationReading[];
