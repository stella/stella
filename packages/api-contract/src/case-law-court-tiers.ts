/**
 * The tiers a reader groups courts by, apex first.
 *
 * Four presentation buckets over the seeded rank scale rather than the
 * registry's own `tier_label` column: that column is free text an operator
 * writes per jurisdiction ("appeal", "district", "procurement-review"), and a
 * response shape cannot be a function of what someone typed into a seed row.
 * The rank scale is closed — the API's rerank module pins it, and `court-weight-seed.test`
 * holds the seeded registry to it — so deriving the label from the rank is
 * total.
 *
 * In the contract so the API's schemas and projections and the web's filter
 * headings read one list; apex first, which is also the order readers scan.
 */
export const COURT_TIER_LABELS = [
  "constitutional",
  "supreme",
  "regional",
  "other",
] as const;

export type CourtTierLabel = (typeof COURT_TIER_LABELS)[number];
