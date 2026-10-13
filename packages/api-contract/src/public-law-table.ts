export const DECISION_COLUMN_IDS = [
  "caseNumber",
  "summary",
  "court",
  "country",
  "date",
  "type",
  "headnote",
  "citedBy",
  "language",
] as const;

export type DecisionColumnId = (typeof DECISION_COLUMN_IDS)[number];

/**
 * What a reader sees before choosing: identity, the hook, and the three
 * signals that place a decision. The headnote column is hidden because the
 * summary column already shows it; the country is implied by the jurisdiction
 * pill, and the language by the case-number cell's language menu.
 */
export const DEFAULT_HIDDEN_DECISION_COLUMN_IDS = [
  "country",
  "headnote",
  "language",
] as const satisfies readonly DecisionColumnId[];
