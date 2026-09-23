import * as v from "valibot";

import {
  DEFAULT_SEARCH_EXCERPT,
  SEARCH_EXCERPTS,
} from "@stll/api-contract/search";
import type { SearchExcerpt } from "@stll/api-contract/search";

import {
  layoutForSurface,
  NO_COLUMN_SIZING,
  PUBLIC_LAW_STORED_LAYOUT_ENTRIES,
  publicLawTableLayout,
  publicLawTableLayouts,
  STORED_COLUMN_ID_LIST,
} from "@/components/public-law-table/public-law-table-layout.logic";
import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import { DEFAULT_HIDDEN_DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";

/**
 * How this browser draws the decision table in one jurisdiction: the shared
 * public-law arrangement, plus how much of the matched passage it asks the
 * search for.
 */
export type DecisionTableLayout = PublicLawTableLayout & {
  /** How much of the matched passage a result carries, as the search cuts it. */
  excerpt: SearchExcerpt;
};

export const DEFAULT_DECISION_TABLE_LAYOUT: DecisionTableLayout = {
  hidden: DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
  order: [],
  pinned: [],
  sizing: NO_COLUMN_SIZING,
  contentMode: "tight",
  excerpt: DEFAULT_SEARCH_EXCERPT,
};

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
    STORED_COLUMN_ID_LIST,
    v.object({
      ...PUBLIC_LAW_STORED_LAYOUT_ENTRIES,
      excerpt: v.optional(v.picklist(SEARCH_EXCERPTS)),
    }),
  ]),
);

export type StoredDecisionLayouts = v.InferOutput<
  typeof StoredDecisionLayoutSchema
>;

type StoredDecisionLayout = StoredDecisionLayouts[string];

/** Every stored arrangement, read once; see `publicLawTableLayouts`. */
export const decisionTableLayouts = (
  stored: StoredDecisionLayouts,
): Record<string, DecisionTableLayout> =>
  publicLawTableLayouts(stored, decisionTableLayout);

export const layoutForCountry = (
  layouts: Record<string, DecisionTableLayout> | null,
  country: string,
): DecisionTableLayout =>
  layoutForSurface({
    defaults: DEFAULT_DECISION_TABLE_LAYOUT,
    layouts,
    surface: country,
  });

/** The layout a stored value stands for; the defaults for anything it omits. */
const decisionTableLayout = (
  stored: StoredDecisionLayout,
): DecisionTableLayout => {
  if (Array.isArray(stored)) {
    return { ...DEFAULT_DECISION_TABLE_LAYOUT, hidden: stored };
  }
  return {
    ...publicLawTableLayout(stored, DEFAULT_DECISION_TABLE_LAYOUT),
    excerpt: stored.excerpt ?? DEFAULT_DECISION_TABLE_LAYOUT.excerpt,
  };
};
