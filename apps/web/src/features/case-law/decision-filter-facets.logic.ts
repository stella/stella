import type { FacetSourceBucket } from "@/components/public-law-table/public-law-facets.logic";
import type { TranslationKey } from "@/i18n/types";

/**
 * How high a court stands, which is the only ordering of courts a reader can
 * scan: an apex court answers a question differently from a district one. The
 * order here is the popover's order, so the order the facets happen to arrive
 * in cannot reshuffle the sections between two searches.
 */
const COURT_TIER_ORDER = [
  "constitutional",
  "supreme",
  "regional",
  "other",
] as const;

export type CourtTier = (typeof COURT_TIER_ORDER)[number];

export const COURT_TIER_LABEL_KEYS = {
  constitutional: "caseLaw.courtTiers.constitutional",
  supreme: "caseLaw.courtTiers.supreme",
  regional: "caseLaw.courtTiers.regional",
  other: "caseLaw.courtTiers.other",
} as const satisfies Record<CourtTier, TranslationKey>;

/**
 * Tiers that start closed. The catch-all tier is long and rarely what a
 * reader came for, so it costs a click rather than a scroll past.
 */
export const COLLAPSED_COURT_TIERS: readonly CourtTier[] = ["other"];

/** Years, where a decade of them is still one glance. */
export const YEAR_SECTION_LIMIT = 10;

/** One court group. A null tier is a list with no ranking to show for it. */
export type CourtTierBuckets = {
  tier: CourtTier | null;
  courts: readonly FacetSourceBucket[];
};

/** The facets the filter popover draws, whichever endpoint they came from. */
export type DecisionFilterFacets = {
  courtTiers: readonly CourtTierBuckets[];
  year: readonly FacetSourceBucket[];
  decisionType: readonly FacetSourceBucket[];
  language: readonly FacetSourceBucket[];
};

/** Whether a stored tier label is one the UI has a heading and a chip for. */
export const isCourtTier = (value: string): value is CourtTier =>
  COURT_TIER_ORDER.some((tier) => tier === value);

/**
 * Court tiers in the popover's own order. A tier name the UI has no heading for
 * is folded into the catch-all rather than dropped: a court the reader cannot
 * see is a court they cannot filter by.
 */
export const orderCourtTiers = (
  tiers: readonly { tierLabel: string; courts: readonly FacetSourceBucket[] }[],
): CourtTierBuckets[] => {
  // A bucket per tier up front, so every tier has a list to collect into and
  // there is no absent case to stand in for. A tier added to the union has to
  // be given one here before this compiles.
  // Annotated, not inferred: empty literals would otherwise infer `never[]`
  // and nothing could be collected into them.
  const byTier: Record<CourtTier, FacetSourceBucket[]> = {
    constitutional: [],
    supreme: [],
    regional: [],
    other: [],
  };

  for (const { courts, tierLabel } of tiers) {
    byTier[isCourtTier(tierLabel) ? tierLabel : "other"].push(...courts);
  }
  return COURT_TIER_ORDER.flatMap((tier) =>
    byTier[tier].length === 0 ? [] : [{ tier, courts: byTier[tier] }],
  );
};

/**
 * Years newest first, whatever order they arrived in. A year facet is a
 * timeline, not a ranking: a reader looking for recent law reads down from the
 * top, and the trim then keeps the most recent decade rather than an arbitrary
 * ten.
 */
const byYearDescending = (
  left: FacetSourceBucket,
  right: FacetSourceBucket,
): number => {
  // A year bucket is a four-digit numeral, not a word: code-unit order is its
  // chronological order, and no collation reading applies to it.
  if (left.value === right.value) {
    return 0;
  }
  return left.value < right.value ? 1 : -1;
};

export const yearsNewestFirst = (
  years: readonly FacetSourceBucket[],
): FacetSourceBucket[] => years.toSorted(byYearDescending);

/**
 * Browse facets as the popover draws them. A corpus-wide listing ranks no
 * courts and reports no types or languages, so the popover shows the two
 * sections it can fill rather than four, two of them empty.
 */
export const decisionFilterFacetsFromBrowse = (browse: {
  court: readonly FacetSourceBucket[];
  year: readonly FacetSourceBucket[];
}): DecisionFilterFacets => ({
  courtTiers:
    browse.court.length === 0 ? [] : [{ tier: null, courts: browse.court }],
  year: yearsNewestFirst(browse.year),
  decisionType: [],
  language: [],
});
