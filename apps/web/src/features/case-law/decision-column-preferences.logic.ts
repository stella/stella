import * as v from "valibot";

import {
  DECISION_CONTENT_MODES,
  DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
} from "@/features/case-law/decision-columns.logic";
import type { DecisionContentMode } from "@/features/case-law/decision-columns.logic";

/**
 * How this browser draws the results table in one jurisdiction: which columns
 * it hides, in what order it puts them, which it keeps in front, and how much
 * of a prose cell it shows.
 *
 * Rules, not storage: the hook next door owns the `Storage` and this module
 * owns what a stored value means, so every rule here is testable without a
 * browser.
 */
export type DecisionTableLayout = {
  hidden: readonly string[];
  /** Column ids in reading order; empty means the schema's own order. */
  order: readonly string[];
  /** Column ids kept in front of the order. */
  pinned: readonly string[];
  contentMode: DecisionContentMode;
};

export const DEFAULT_DECISION_TABLE_LAYOUT: DecisionTableLayout = {
  hidden: DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
  order: [],
  pinned: [],
  contentMode: "tight",
};

const columnIdList = v.array(v.string());

/**
 * What storage holds, per jurisdiction.
 *
 * The bare array is what browsers stored while the only preference was the
 * hidden set. It is read, never written; drop the union once no reader can
 * still be carrying a value written before the order and pins existed
 * (`case_law_hidden_columns` cleared, or the key renamed).
 */
export const StoredDecisionLayoutSchema = v.record(
  v.string(),
  v.union([
    columnIdList,
    v.object({
      hidden: v.optional(columnIdList),
      order: v.optional(columnIdList),
      pinned: v.optional(columnIdList),
      contentMode: v.optional(v.picklist(DECISION_CONTENT_MODES)),
    }),
  ]),
);

export type StoredDecisionLayouts = v.InferOutput<
  typeof StoredDecisionLayoutSchema
>;

type StoredDecisionLayout = StoredDecisionLayouts[string];

/** The layout a stored value stands for; the defaults for anything it omits. */
export const decisionTableLayout = (
  stored: StoredDecisionLayout | undefined,
): DecisionTableLayout => {
  if (stored === undefined) {
    return DEFAULT_DECISION_TABLE_LAYOUT;
  }
  if (Array.isArray(stored)) {
    return { ...DEFAULT_DECISION_TABLE_LAYOUT, hidden: stored };
  }
  return {
    hidden: stored.hidden ?? DEFAULT_DECISION_TABLE_LAYOUT.hidden,
    order: stored.order ?? DEFAULT_DECISION_TABLE_LAYOUT.order,
    pinned: stored.pinned ?? DEFAULT_DECISION_TABLE_LAYOUT.pinned,
    contentMode:
      stored.contentMode ?? DEFAULT_DECISION_TABLE_LAYOUT.contentMode,
  };
};

/**
 * The columns in the order they are drawn: what the reader arranged, then
 * whatever the table has gained since, in the schema's own order.
 *
 * Ids the schema no longer has are dropped rather than kept, so a stored order
 * cannot resurrect a column that was removed.
 */
export const decisionColumnOrder = (
  available: readonly string[],
  stored: readonly string[],
): string[] => {
  const exists = new Set(available);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const columnId of stored) {
    if (exists.has(columnId) && !seen.has(columnId)) {
      seen.add(columnId);
      ordered.push(columnId);
    }
  }
  for (const columnId of available) {
    if (!seen.has(columnId)) {
      ordered.push(columnId);
    }
  }
  return ordered;
};

/** Only pins the table can honour; the rest are forgotten. */
export const decisionColumnPins = (
  available: readonly string[],
  stored: readonly string[],
): string[] => {
  const exists = new Set(available);
  return [...new Set(stored)].filter((columnId) => exists.has(columnId));
};

export type DecisionColumnMove = "earlier" | "later";

/**
 * One step of a column through the order. A column already at the end it is
 * moving towards stays where it is, so the control is always safe to press.
 */
export const withDecisionColumnMoved = (
  order: readonly string[],
  columnId: string,
  move: DecisionColumnMove,
): string[] => {
  const index = order.indexOf(columnId);
  if (index === -1) {
    return [...order];
  }
  const target = move === "earlier" ? index - 1 : index + 1;
  if (target < 0 || target >= order.length) {
    return [...order];
  }
  const next = [...order];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) {
    return [...order];
  }
  next.splice(target, 0, moved);
  return next;
};

export const withDecisionColumnPinned = (
  pinned: readonly string[],
  columnId: string,
  pin: boolean,
): string[] => {
  const next = pinned.filter((id) => id !== columnId);
  return pin ? [...next, columnId] : next;
};
