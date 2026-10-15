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

/** How much of a table cell is visible before the reader opens its row. */
export const TABLE_CONTENT_MODES = ["tight", "fit-content"] as const;

export type TableContentMode = (typeof TABLE_CONTENT_MODES)[number];

export const STATUTE_COLUMN_IDS = [
  "act",
  "type",
  "validity",
  "firstVersion",
  "amendments",
  "lastAmended",
  "citedBy",
] as const;

export type StatuteColumnId = (typeof STATUTE_COLUMN_IDS)[number];
