// Passive regression fixture for `exhaustive-union-map/exhaustive-union-map`.
//
// Each `oxlint-disable-next-line` below suppresses a map the rule must flag;
// if the detector regresses, the directive goes unused and the fixture lint
// fails. Unsuppressed declarations are maps the rule must accept.

type Tier = "compliant" | "deviation";

declare const tier: string;

// oxlint-disable-next-line exhaustive-union-map/exhaustive-union-map -- fixture proves a string-keyed lookup table is flagged
const OPEN_LABELS = {
  compliant: "On standard",
  deviation: "Deviates",
} as const satisfies Record<string, string>;

const TIER_LABELS = {
  compliant: "On standard",
  deviation: "Deviates",
} as const satisfies Record<Tier, string>;

export const labelFor = (value: string): string | null =>
  Object.hasOwn(OPEN_LABELS, value) ? value : null;

export const tierLabel = (value: Tier): string => TIER_LABELS[value];

export const isKnownTier = Object.hasOwn(TIER_LABELS, tier);
