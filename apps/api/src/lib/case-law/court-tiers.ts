import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

import {
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";

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
