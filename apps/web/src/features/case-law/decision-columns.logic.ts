import type { ReactElement } from "react";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Decision } from "@/features/case-law/components/decision-cells";
import type { TranslationKey } from "@/i18n/types";
import type { TableContentMode } from "@/lib/workspaces/table-store.logic";

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

type DecisionColumnModel = {
  /** The width the column starts at, before a stored resize. */
  size: number;
  /** Whether the reader may hide it. */
  hide: boolean;
  emphasis: "content" | "metadata";
};

/**
 * What a reader may do to each decision column, and how wide it starts.
 *
 * The case-number column is the row's identity, so it never hides; the rest
 * are the reader's to arrange. Data rather than part of the renderer, so the
 * column set stays testable without drawing one.
 */
export const DECISION_COLUMN_MODEL = {
  caseNumber: { size: 320, hide: false, emphasis: "content" },
  summary: { size: 460, hide: true, emphasis: "content" },
  court: { size: 220, hide: true, emphasis: "metadata" },
  country: { size: 90, hide: true, emphasis: "metadata" },
  date: { size: 130, hide: true, emphasis: "metadata" },
  type: { size: 120, hide: true, emphasis: "metadata" },
  headnote: { size: 420, hide: true, emphasis: "content" },
  citedBy: { size: 96, hide: true, emphasis: "metadata" },
  language: { size: 120, hide: true, emphasis: "metadata" },
} as const satisfies Record<DecisionColumnId, DecisionColumnModel>;

/** The narrowest a decision column may be dragged. */
export const DECISION_COLUMN_MIN_SIZE = 80;

/**
 * What draws a decision column: the column itself, drawn by
 * `renderDecisionCell`. One member of the table's column union, declared
 * here because the public results page cannot reach into a matter's route.
 */
export type DecisionColumnRender = {
  type: "decision";
  column: DecisionColumnId;
};

/**
 * A column the host adds to the decision model: the note a matter pinned the
 * decision with, the way back out of that matter. It is arranged, hidden and
 * pinned like any other column, because a reader does not care where a column
 * came from.
 */
export type DecisionExtraColumn = {
  id: string;
  /** Already translated; also the label the column chooser shows. */
  label: string;
  size: number;
  /** Synchronous by type: a cell is an element or text, never a promise. */
  render: (decision: Decision) => ReactElement | string | null;
};

/** What draws a host-added decision column. One member of the column union. */
export type DecisionExtraColumnRender = {
  type: "decision-extra";
  column: DecisionExtraColumn;
};

/** The decision columns' labels, resolved for the reader by the caller. */
export type DecisionTableLabels = Record<DecisionColumnId, string>;

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
 * What the case-number column holds across the rows on screen: dockets only,
 * or at least one decision whose primary reference is a reporter or neutral
 * citation. A citation is not a case number, so a column holding one is
 * named for what both kinds are.
 */
export type DecisionReferenceColumnKind = "case-number" | "reference";

export const decisionReferenceColumnKind = (
  decisions: readonly Pick<Decision, "caseNumberType">[],
): DecisionReferenceColumnKind =>
  decisions.every(
    ({ caseNumberType }) =>
      caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  )
    ? "case-number"
    : "reference";

const DECISION_REFERENCE_COLUMN_LABEL_KEYS = {
  "case-number": DECISION_COLUMN_LABEL_KEYS.caseNumber,
  reference: "common.reference",
} as const satisfies Record<DecisionReferenceColumnKind, TranslationKey>;

/** A decision column's label, given what the case-number column holds. */
export const decisionColumnLabelKey = (
  column: DecisionColumnId,
  referenceKind: DecisionReferenceColumnKind,
): TranslationKey =>
  column === "caseNumber"
    ? DECISION_REFERENCE_COLUMN_LABEL_KEYS[referenceKind]
    : DECISION_COLUMN_LABEL_KEYS[column];

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

type DecisionColumnWidth = (typeof DECISION_COLUMN_WIDTHS)[DecisionColumnId];

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
const DECISION_COLUMN_WIDTH_CLASS_NAMES = {
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
 * How much of a prose cell a row shows: two lines, so a page of rows can be
 * scanned, or all of it, so one row can be read. The same two modes the
 * workspace table's density control offers, under the same words, and the
 * same type, so the public tables and a matter's cannot offer different ones.
 */
export type DecisionContentMode = TableContentMode;

const DECISION_CLAMP_CLASS_NAMES = {
  tight: "line-clamp-2",
  "fit-content": "",
} as const satisfies Record<DecisionContentMode, string>;

/** The clamp a prose cell carries in this mode; empty when it carries none. */
export const decisionClampClassName = (mode: DecisionContentMode): string =>
  DECISION_CLAMP_CLASS_NAMES[mode];

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
