import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { isDecisionTypeKind } from "@stll/api-contract/case-law-decision-types";
import type { DecisionTypeKind } from "@stll/api-contract/case-law-decision-types";

import type {
  CountedSourceFacetBucket,
  FacetSourceBucket,
} from "@/components/public-law-table/public-law-facets.logic";
import type { TranslationKey } from "@/i18n/types";

/**
 * How high a court stands, which is the only ordering of courts a reader can
 * scan. The contract's order (apex first) is the popover's order, so the order
 * the facets happen to arrive in cannot reshuffle the sections between two
 * searches.
 */
export type CourtTier = CourtTierLabel;

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

/**
 * The reader's word for each canonical decision type. The facet reports kinds,
 * never a publisher's spelling (`usn.`) or an enum member, so this map is the
 * only text a type bucket is drawn with; total over the kinds, so a kind added
 * to the contract has no label until it is given one here.
 */
const DECISION_TYPE_KIND_LABEL_KEYS = {
  judgment: "caseLaw.decisionTypes.judgment",
  order: "caseLaw.decisionTypes.order",
  finding: "caseLaw.decisionTypes.finding",
  resolution: "caseLaw.decisionTypes.resolution",
  opinion: "caseLaw.decisionTypes.opinion",
  decision: "caseLaw.decisionTypes.decision",
  administrative_decision: "caseLaw.decisionTypes.administrative_decision",
  ministry_of_justice_decision:
    "caseLaw.decisionTypes.ministry_of_justice_decision",
  penal_order: "caseLaw.decisionTypes.penal_order",
  payment_order: "caseLaw.decisionTypes.payment_order",
  uniformity_decision: "caseLaw.decisionTypes.uniformity_decision",
  principle_decision: "caseLaw.decisionTypes.principle_decision",
  merits_decision: "caseLaw.decisionTypes.merits_decision",
  leave_refused: "caseLaw.decisionTypes.leave_refused",
  court_direction: "caseLaw.decisionTypes.court_direction",
  statement_of_reasons: "caseLaw.decisionTypes.statement_of_reasons",
  minutes_extract: "caseLaw.decisionTypes.minutes_extract",
  signalling_decision: "caseLaw.decisionTypes.signalling_decision",
  individual_tax_ruling: "caseLaw.decisionTypes.individual_tax_ruling",
  general_tax_ruling: "caseLaw.decisionTypes.general_tax_ruling",
  tax_explanations: "caseLaw.decisionTypes.tax_explanations",
  binding_rate_information: "caseLaw.decisionTypes.binding_rate_information",
  binding_excise_information:
    "caseLaw.decisionTypes.binding_excise_information",
  protective_opinion: "caseLaw.decisionTypes.protective_opinion",
  top_up_tax_opinion: "caseLaw.decisionTypes.top_up_tax_opinion",
  other: "caseLaw.decisionTypes.other",
} as const satisfies Record<DecisionTypeKind, TranslationKey>;

/** A type facet bucket as the search reports it: a kind and its count. */
export type DecisionTypeFacetBucket = {
  value: DecisionTypeKind;
  count: number;
};

/** A type facet entry with the key of its label, not yet translated. */
type DecisionTypeSectionBucket = {
  value: string;
  /** Null only for a selection that names no kind: a link's own value. */
  labelKey: (typeof DECISION_TYPE_KIND_LABEL_KEYS)[DecisionTypeKind] | null;
  count: number | null;
};

/**
 * The type section's entries, each with its kind's label key. The selected
 * kind is listed even when the page reports no bucket for it (a cursor page
 * carries no facets), labelled like any other, because the shared section
 * would otherwise draw the bare selection value: `order`, or worse,
 * `ministry_of_justice_decision`.
 */
export const decisionTypeSectionBuckets = (
  buckets: readonly DecisionTypeFacetBucket[],
  selectedValue: string | undefined,
): DecisionTypeSectionBucket[] => {
  const listed: DecisionTypeSectionBucket[] = buckets.map(
    ({ value, count }) => ({
      value,
      labelKey: DECISION_TYPE_KIND_LABEL_KEYS[value],
      count,
    }),
  );
  if (
    selectedValue === undefined ||
    listed.some(({ value }) => value === selectedValue)
  ) {
    return listed;
  }
  return [
    {
      value: selectedValue,
      labelKey: isDecisionTypeKind(selectedValue)
        ? DECISION_TYPE_KIND_LABEL_KEYS[selectedValue]
        : null,
      count: null,
    },
    ...listed,
  ];
};

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
  decisionType: readonly DecisionTypeFacetBucket[];
  language: readonly FacetSourceBucket[];
  source: readonly CountedSourceFacetBucket[];
};

/** Whether a stored tier label is one the UI has a heading and a chip for. */
export const isCourtTier = (value: string): value is CourtTier =>
  COURT_TIER_LABELS.some((tier) => tier === value);

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
  return COURT_TIER_LABELS.flatMap((tier) =>
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
  source: [],
});
