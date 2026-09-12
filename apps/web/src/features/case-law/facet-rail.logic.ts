import type { TranslationKey } from "@/i18n/types";

/**
 * What one facet section shows: the buckets the current result set reports,
 * trimmed to a scannable head, with the reader's own choice always among them.
 */

/** One choice in a facet section. `count` is null when no number is known. */
export type FacetItem = {
  value: string;
  label: string;
  count: number | null;
};

export type FacetSectionView = {
  items: readonly FacetItem[];
  /** Items the trim left out; zero once the section is expanded. */
  hiddenCount: number;
};

/** A bucket as either facet source reports it. */
export type FacetSourceBucket = {
  value: string;
  label?: string | null | undefined;
  count?: number | null | undefined;
};

export type FacetSectionOptions = {
  buckets: readonly FacetSourceBucket[];
  /** How many items show before "Show all". */
  limit: number;
  expanded: boolean;
  /** The value the URL selects in this section, if any. */
  selectedValue: string | undefined;
};

const toItem = (bucket: FacetSourceBucket): FacetItem => ({
  value: bucket.value,
  label: bucket.label ?? bucket.value,
  count: bucket.count ?? null,
});

/**
 * A section's visible items.
 *
 * The selected value survives two ways of disappearing. Cross-filtered counts
 * exclude a facet's own selection, but a bucket can still drop out of the
 * page's facets (another filter narrowed it away, or a cursor page carries no
 * facets at all); then it is re-added, with no count, because a filter the
 * reader cannot see is a filter they cannot clear. And a selection ranked
 * below the trim is appended rather than dropped, for the same reason.
 */
export const facetSectionView = ({
  buckets,
  expanded,
  limit,
  selectedValue,
}: FacetSectionOptions): FacetSectionView => {
  const items = buckets.map(toItem);
  if (
    selectedValue !== undefined &&
    !items.some((item) => item.value === selectedValue)
  ) {
    items.unshift({ value: selectedValue, label: selectedValue, count: null });
  }

  if (expanded || items.length <= limit) {
    return { items, hiddenCount: 0 };
  }

  const shown = items.slice(0, limit);
  const selected =
    selectedValue === undefined
      ? undefined
      : items.find((item) => item.value === selectedValue);
  if (selected !== undefined && !shown.includes(selected)) {
    shown.push(selected);
  }
  return { items: shown, hiddenCount: items.length - shown.length };
};

/**
 * How high a court stands, which is the only ordering of courts a reader can
 * scan: an apex court answers a question differently from a district one. The
 * order here is the rail's order, so the order the facets happen to arrive in
 * cannot reshuffle the sections between two searches.
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

/** How many items a section shows before it offers to show them all. */
export const FACET_SECTION_LIMIT = 8;

/** Years, where a decade of them is still one glance. */
export const YEAR_SECTION_LIMIT = 10;

/** One court group. A null tier is a list with no ranking to show for it. */
export type CourtTierBuckets = {
  tier: CourtTier | null;
  courts: readonly FacetSourceBucket[];
};

/** The facets the rail draws, whichever endpoint they came from. */
export type DecisionRailFacets = {
  courtTiers: readonly CourtTierBuckets[];
  year: readonly FacetSourceBucket[];
  decisionType: readonly FacetSourceBucket[];
  source: readonly FacetSourceBucket[];
  language: readonly FacetSourceBucket[];
};

const isCourtTier = (value: string): value is CourtTier =>
  COURT_TIER_ORDER.some((tier) => tier === value);

/**
 * Court tiers in the rail's own order. A tier name the UI has no heading for
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
 * Browse facets as the rail draws them. A corpus-wide listing ranks no courts
 * and reports no types, sources or languages, so the rail shows the two
 * sections it can fill rather than five, three of them empty.
 */
export const railFacetsFromBrowse = (browse: {
  court: readonly FacetSourceBucket[];
  year: readonly FacetSourceBucket[];
}): DecisionRailFacets => ({
  courtTiers:
    browse.court.length === 0 ? [] : [{ tier: null, courts: browse.court }],
  year: yearsNewestFirst(browse.year),
  decisionType: [],
  source: [],
  language: [],
});
