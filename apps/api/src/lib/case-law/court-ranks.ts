/**
 * The ranks a court can hold, and the rank a directory court holds by its
 * directory tier. The seed renders its name rows from these
 * (`court-weight-seed.ts`) and stores the directory's id ranks. TypeScript
 * reads the directory; SQL reads the seeded rank table.
 */
import { type SQL, sql } from "drizzle-orm";

import {
  resolveUsCourt,
  US_COURT_BY_CANONICAL_NAME,
  US_COURTS,
  type UsCourtTier,
} from "@stll/api-contract/us-courts";

import { LOWEST_COURT_TIER } from "@/api/lib/legal-search/rerank";

export type CourtRank = { tier: number; tierLabel: string; weight: number };

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
  administrative: { tier: 1, tierLabel: "administrative", weight: 3 },
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

/** The rank of a court nobody ranks: the bottom tier and the default weight. */
export const UNRANKED_COURT_RANK = {
  tier: LOWEST_COURT_TIER,
  weight: 1,
} as const;

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

/** Every accepted directory id, including ids holding the unranked values. */
export const usCourtDirectoryRankRows = () =>
  US_COURTS.map(({ id, tier }) => ({
    country: "USA",
    courtId: id,
    tier: US_TIER_RANK[tier].tier,
    weight: US_TIER_RANK[tier].weight,
  }));

/**
 * The rank of the accepted United States court stored under exactly this
 * canonical name, or null. For a reader that holds only the name (a court
 * facet bucket): the write boundary stores a directory court under its
 * canonical name, and the directory's canonical names are unique.
 */
export const usCourtRankByCanonicalName = (court: string): CourtRank | null => {
  const directoryCourt = US_COURT_BY_CANONICAL_NAME.get(court);
  return directoryCourt === undefined
    ? null
    : US_TIER_RANK[directoryCourt.tier];
};

type RankField = "tier" | "weight";

/**
 * The stored directory rank for a court id. The composite primary key makes
 * each lookup unique and indexed; the seed migration keeps it aligned with
 * `usCourtRank`.
 *
 * A NULL or unaccepted id takes the fallback, the unranked rank: never a name
 * pattern and never another jurisdiction's rank. The write boundary admits
 * accepted ids only, so a stored row reaches the fallback only through corruption
 * or directory drift; `decisionCourtWeight` gives the same row the same rank
 * in TypeScript and reports it.
 */
export const usCourtRankSql = (courtIdColumn: string, field: RankField): SQL =>
  sql`COALESCE((SELECT r.${sql.raw(field)} FROM case_law_court_directory_ranks r WHERE r.country = 'USA' AND r.court_id = ${sql.raw(courtIdColumn)}), ${sql.raw(String(UNRANKED_COURT_RANK[field]))})`;
