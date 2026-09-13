import { panic } from "better-result";
import * as v from "valibot";

import {
  DECISION_CONTENT_MODES,
  DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
} from "@/features/case-law/decision-columns.logic";
import type { DecisionContentMode } from "@/features/case-law/decision-columns.logic";

/** Whether the facet rail takes a column beside the results, or folds away. */
export const DECISION_FACET_RAIL_STATES = ["collapsed", "open"] as const;

export type DecisionFacetRailState =
  (typeof DECISION_FACET_RAIL_STATES)[number];

/**
 * How this browser draws the results table in one jurisdiction: which columns
 * it hides, in what order it puts them, which it keeps in front, how much of a
 * prose cell it shows, and whether the facet rail takes its column.
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
  facetRail: DecisionFacetRailState;
};

export const DEFAULT_DECISION_TABLE_LAYOUT: DecisionTableLayout = {
  hidden: DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
  order: [],
  pinned: [],
  contentMode: "tight",
  // The results need the width more than the rail does, and nothing is hidden
  // by folding it: the chips row still names every filter that is on.
  facetRail: "collapsed",
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
      facetRail: v.optional(v.picklist(DECISION_FACET_RAIL_STATES)),
    }),
  ]),
);

export type StoredDecisionLayouts = v.InferOutput<
  typeof StoredDecisionLayoutSchema
>;

type StoredDecisionLayout = StoredDecisionLayouts[string];

/**
 * Every stored arrangement, read once.
 *
 * The table's state is handed to TanStack as controlled state, which it
 * compares by identity: a layout rebuilt during render is a different object
 * every time, so the table publishes state the component did not change, the
 * publish re-renders the component, and the render rebuilds the layout again.
 * Normalising at the storage read, and looking the country up afterwards, is
 * what makes that loop impossible rather than merely unlikely.
 */
export const decisionTableLayouts = (
  stored: StoredDecisionLayouts,
): Record<string, DecisionTableLayout> => {
  const layouts: Record<string, DecisionTableLayout> = {};
  for (const [country, value] of Object.entries(stored)) {
    layouts[country] = decisionTableLayout(value);
  }
  return layouts;
};

/**
 * The arrangement of one jurisdiction: the same object on every call, because
 * the table is given it on every render.
 */
export const layoutForCountry = (
  layouts: Record<string, DecisionTableLayout> | null,
  country: string,
): DecisionTableLayout => layouts?.[country] ?? DEFAULT_DECISION_TABLE_LAYOUT;

/** The layout a stored value stands for; the defaults for anything it omits. */
const decisionTableLayout = (
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
    facetRail: stored.facetRail ?? DEFAULT_DECISION_TABLE_LAYOUT.facetRail,
  };
};

/**
 * The rail's other state. A switch rather than a negation, so a third state
 * would fail here instead of silently meaning "collapsed".
 */
export const toggledFacetRail = (
  state: DecisionFacetRailState,
): DecisionFacetRailState => {
  switch (state) {
    case "collapsed":
      return "open";
    case "open":
      return "collapsed";
    default:
      state satisfies never;
      return panic(`Unhandled facet rail state: ${String(state)}`);
  }
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
