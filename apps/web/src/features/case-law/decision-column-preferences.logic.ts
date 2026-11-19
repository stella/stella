import * as v from "valibot";

import {
  canonicalizePublicCountry,
  PUBLIC_COUNTRIES,
} from "@stll/api-contract/public-country-capability";
import {
  DECISION_COLUMN_IDS,
  DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
} from "@stll/api-contract/public-law-table";
import {
  DEFAULT_SEARCH_EXCERPT,
  SEARCH_EXCERPTS,
} from "@stll/api-contract/search";
import type { SearchExcerpt } from "@stll/api-contract/search";

import {
  layoutForSurface,
  NO_COLUMN_SIZING,
  publicLawStoredLayoutEntries,
  publicLawTableLayout,
  publicLawTableLayouts,
} from "@/components/public-law-table/public-law-table-layout.logic";
import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";

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

/** Strict cookie representation, keyed only by canonical public jurisdictions. */
export const StoredDecisionLayoutSchema = v.pipe(
  v.unknown(),
  v.check(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  v.record(
    v.picklist(PUBLIC_COUNTRIES.map(canonicalizePublicCountry)),
    v.strictObject({
      ...publicLawStoredLayoutEntries(DECISION_COLUMN_IDS),
      excerpt: v.optional(v.picklist(SEARCH_EXCERPTS)),
    }),
  ),
);

export type StoredDecisionLayouts = v.InferOutput<
  typeof StoredDecisionLayoutSchema
>;

type StoredDecisionLayout = NonNullable<
  StoredDecisionLayouts[keyof StoredDecisionLayouts]
>;

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
): DecisionTableLayout => ({
  ...publicLawTableLayout(stored, DEFAULT_DECISION_TABLE_LAYOUT),
  excerpt: stored.excerpt ?? DEFAULT_DECISION_TABLE_LAYOUT.excerpt,
});
