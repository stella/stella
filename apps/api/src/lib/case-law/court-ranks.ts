/**
 * The ranks a court can hold, and the rank a directory court holds by its
 * directory tier. The seed renders its rows from these (`court-weight-seed.ts`)
 * and the ranking reads a directory court's rank from them by id, so the two
 * cannot disagree about a court the seed names.
 */
import { resolveUsCourt, type UsCourtTier } from "@stll/api-contract/us-courts";

type CourtRank = { tier: number; tierLabel: string; weight: number };

/**
 * A tier and its weight belong to the label, not to the jurisdiction, so two
 * countries cannot spell the same rank with different numbers.
 */
export const RANK = {
  constitutional: { tier: 4, tierLabel: "constitutional", weight: 10 },
  supreme: { tier: 3, tierLabel: "supreme", weight: 8 },
  regional: { tier: 2, tierLabel: "regional", weight: 4 },
  appeal: { tier: 2, tierLabel: "appeal", weight: 5 },
  "procurement-review": { tier: 1, tierLabel: "procurement-review", weight: 3 },
  district: { tier: 1, tierLabel: "district", weight: 2 },
  "administrative-labour": {
    tier: 1,
    tierLabel: "administrative-labour",
    weight: 3,
  },
  special: { tier: 1, tierLabel: "special", weight: 3 },
} as const satisfies Record<string, CourtRank>;

/** The rank each United States directory tier holds. */
export const US_TIER_RANK = {
  supreme: RANK.supreme,
  appellate: RANK.appeal,
  trial: RANK.district,
  special: RANK.special,
} as const satisfies Record<UsCourtTier, (typeof RANK)[keyof typeof RANK]>;

/**
 * The rank of an accepted United States court, by its exact directory id, or
 * null for an id the directory does not accept.
 */
export const usCourtRank = (courtId: string): CourtRank | null => {
  const resolution = resolveUsCourt(courtId);
  return resolution.type === "accepted"
    ? US_TIER_RANK[resolution.court.tier]
    : null;
};
