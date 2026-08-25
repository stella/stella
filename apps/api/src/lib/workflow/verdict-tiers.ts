import type { OptionColor, PropertyContent } from "@/api/db/schema-validators";

// The verdict states a graded cell can hold. The first four form the compliance
// ladder, ordered best to worst (`compliant` -> `missing`). The last two sit
// outside it: `additional` means the document carries something the standard
// does not speak to (a limb, a covenant, a carve-out present only in the
// target), and `not-applicable` means the position does not pertain to this
// document at all. Neither is a pass or a flagged gap, so both are excluded
// from the compliance denominator (see `computeRiskRollup`). A graded position
// materializes a single-select property whose options are exactly these states;
// the verdict engine writes one of them per in-scope document.
export const VERDICT_TIERS = [
  "compliant",
  "fallback",
  "deviation",
  "missing",
  "additional",
  "not-applicable",
] as const;

export type VerdictTier = (typeof VERDICT_TIERS)[number];

// Named preset colors (see `OptionColor`): green = on-standard, amber = an
// accepted fallback, red = a deviation to flag, gray = nothing extracted, blue
// = something the standard does not cover. `not-applicable` shares the neutral
// gray swatch (it is not a risk signal); the review surface distinguishes the
// two neutrals visually (a dashed chip for not-applicable vs the solid muted
// chip for missing).
export const VERDICT_TIER_COLORS = {
  compliant: "green",
  fallback: "amber",
  deviation: "red",
  missing: "gray",
  additional: "blue",
  "not-applicable": "gray",
} as const satisfies Record<VerdictTier, OptionColor>;

/**
 * The single-select content shared by every verdict property: every verdict
 * state as a named-color option, with no fallback (a verdict is always written
 * explicitly, including `missing` and `not-applicable`).
 */
export const buildVerdictContent = (): PropertyContent => ({
  version: 1,
  type: "single-select",
  options: VERDICT_TIERS.map((tier) => ({
    value: tier,
    color: VERDICT_TIER_COLORS[tier],
  })),
  fallback: null,
});
