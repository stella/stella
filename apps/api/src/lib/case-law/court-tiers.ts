import {
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";

/**
 * The tiers a reader groups courts by, apex first.
 *
 * Four presentation buckets over the seeded rank scale rather than the
 * registry's own `tier_label` column: that column is free text an operator
 * writes per jurisdiction ("appeal", "district", "procurement-review"), and a
 * response shape cannot be a function of what someone typed into a seed row.
 * The rank scale is closed — `rerank.ts` pins it, and `court-weight-seed.test`
 * holds the seeded registry to it — so deriving the label from the rank is
 * total.
 *
 * A leaf module on purpose: the HTTP route schema and the agent-facing
 * projection both declare these values, and neither may pull the registry
 * loader's database handle in behind them.
 */
export const COURT_TIER_LABELS = [
  "constitutional",
  "supreme",
  "regional",
  "other",
] as const;

export type CourtTierLabel = (typeof COURT_TIER_LABELS)[number];

/**
 * The presentation tier of a seeded rank, or `other` for a rank outside the
 * pinned scale.
 *
 * Outside, not clamped: the registry column takes any integer and the
 * ingestion role can write it, so a stray `5` clamped upward would present an
 * unranked court as a constitutional one — the loudest possible wrong answer.
 * A rank nobody can read groups with the courts nobody ranked.
 */
export const courtTierLabel = (tier: number): CourtTierLabel => {
  if (
    !Number.isInteger(tier) ||
    tier < LOWEST_COURT_TIER ||
    tier > HIGHEST_COURT_TIER
  ) {
    return "other";
  }
  switch (tier) {
    case HIGHEST_COURT_TIER:
      return "constitutional";
    case 3:
      return "supreme";
    case 2:
      return "regional";
    default:
      return "other";
  }
};
