import type { OptionColor, PropertyContent } from "@/api/db/schema-validators";

// The four compliance tiers a verdict cell can hold, ordered worst-known-best
// to worst. A graded position materializes a single-select property whose
// options are exactly these tiers; the verdict engine writes one of them per
// in-scope document.
export const VERDICT_TIERS = [
  "compliant",
  "fallback",
  "deviation",
  "missing",
] as const;

export type VerdictTier = (typeof VERDICT_TIERS)[number];

// Named preset colors (see `OptionColor`): green = on-standard, amber = an
// accepted fallback, red = a deviation to flag, gray = nothing extracted.
export const VERDICT_TIER_COLORS = {
  compliant: "green",
  fallback: "amber",
  deviation: "red",
  missing: "gray",
} as const satisfies Record<VerdictTier, OptionColor>;

/**
 * The single-select content shared by every verdict property: the four tiers
 * as named-color options, with no fallback (a verdict is always written
 * explicitly, including `missing`).
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
