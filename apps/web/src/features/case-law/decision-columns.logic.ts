import type { TranslationKey } from "@/i18n/types";

/**
 * The decision column model as data: which columns exist, what they are
 * called, which of them a reader sees before touching anything, and what the
 * case-number cell has to say itself because no column is saying it.
 *
 * Separate from the cells that draw them so the rules can be tested without a
 * renderer, and so the identity line cannot drift from the visible column set
 * it is derived from.
 */
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

export const DECISION_COLUMN_LABEL_KEYS = {
  caseNumber: "caseLaw.columns.caseNumber",
  summary: "caseLaw.columns.summary",
  court: "common.court",
  country: "common.country",
  date: "common.date",
  type: "common.type",
  headnote: "caseLaw.columns.headnote",
  citedBy: "caseLaw.columns.citedBy",
  language: "common.language",
} as const satisfies Record<DecisionColumnId, TranslationKey>;

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

/**
 * How much of the row's width a column may take.
 *
 * A table whose every column sizes to its own content is as wide as the
 * longest headnote in it, which on a results page means a horizontal scroll
 * hiding the columns that place a decision. So exactly one kind of column
 * gives: the prose ones absorb the slack and wrap inside it, and the short,
 * scannable ones keep their single line at their natural width.
 */
export const DECISION_COLUMN_WIDTHS = {
  caseNumber: "fit",
  summary: "prose",
  court: "fit",
  country: "fit",
  date: "fit",
  type: "fit",
  headnote: "prose",
  citedBy: "fit",
  language: "fit",
} as const satisfies Record<DecisionColumnId, "fit" | "prose">;

export type DecisionColumnWidth =
  (typeof DECISION_COLUMN_WIDTHS)[DecisionColumnId];

/**
 * The classes that carry out that decision, as an explicit map rather than a
 * composed string, so the utility scanner sees every class it has to emit.
 *
 * `w-px` on a head cell is the table-layout idiom for "as narrow as the
 * content needs"; `w-full` asks for everything left over, and the browser
 * shrinks the columns that can wrap before it overflows the container. The
 * shared table cell sets `whitespace-nowrap`, which is why a prose cell has to
 * turn it back off: without that the clamp has nothing to clamp and the row
 * grows to the width of the whole headnote.
 */
export const DECISION_COLUMN_WIDTH_CLASS_NAMES = {
  fit: { head: "w-px", cell: "whitespace-nowrap" },
  prose: {
    head: "w-full",
    cell: "w-full min-w-0 align-top break-words whitespace-normal",
  },
} as const satisfies Record<
  DecisionColumnWidth,
  { head: string; cell: string }
>;

export const decisionColumnWidthClassNames = (
  columnId: DecisionColumnId,
): { head: string; cell: string } =>
  DECISION_COLUMN_WIDTH_CLASS_NAMES[DECISION_COLUMN_WIDTHS[columnId]];

/**
 * Facts the case-number cell repeats under the case number when, and only
 * when, no column of its own is showing them. Order is the reading order of
 * the line.
 */
export const DECISION_IDENTITY_LINE_FIELDS = [
  "court",
  "date",
  "type",
] as const satisfies readonly DecisionColumnId[];

export type DecisionIdentityLineField =
  (typeof DECISION_IDENTITY_LINE_FIELDS)[number];

/**
 * Which facts the identity line carries, given the columns on screen. Derived
 * from the visible set rather than from a stored preference, so hiding a
 * column moves its value into the line and showing it takes the value back
 * out; the row never says the same thing twice.
 */
export const decisionIdentityLineFields = (
  visibleColumnIds: readonly string[],
): readonly DecisionIdentityLineField[] => {
  const visible = new Set(visibleColumnIds);
  return DECISION_IDENTITY_LINE_FIELDS.filter((field) => !visible.has(field));
};
