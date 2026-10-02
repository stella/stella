/** The whole document's role as a declared publisher enum states it. */
export const DECISION_DOCUMENT_ROLE = {
  RULING: "ruling",
  REASONS: "reasons",
} as const;

export type DecisionDocumentRole =
  (typeof DECISION_DOCUMENT_ROLE)[keyof typeof DECISION_DOCUMENT_ROLE];

/** Pipeline-owned metadata projection of the typed document role. */
export const DECISION_DOCUMENT_ROLE_METADATA_KEY = "documentRole";
