/**
 * The ranks a court can hold, and the rank a directory court holds by its
 * directory tier. The seed renders its name rows from these
 * (`court-weight-seed.ts`); a directory court is ranked by its id alone, in
 * TypeScript by `usCourtRank` and in SQL by `usCourtRankSql`, both read from
 * the one directory.
 */
import { type SQL, sql } from "drizzle-orm";

import {
  resolveUsCourt,
  US_COURT_BY_CANONICAL_NAME,
  US_COURTS,
  type UsCourtTier,
} from "@stll/api-contract/us-courts";

import { LOWEST_COURT_TIER } from "@/api/lib/legal-search/rerank";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

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

/** A `text[]` input literal of directory ids, each element quoted. */
const courtIdArrayLiteral = (ids: readonly string[]): string =>
  `{${ids.map((id) => `"${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;

/** A rank value and the `text[]` literal of the accepted ids holding it. */
type RankGroup = { value: number; ids: string };

/**
 * The accepted ids grouped by the rank value they hold, highest first. A
 * group at the unranked value is left out: the ELSE answers it already.
 */
const rankGroups = (field: RankField): readonly RankGroup[] => {
  const idsByValue = new Map<number, string[]>();
  for (const { id, tier } of US_COURTS) {
    const value = US_TIER_RANK[tier][field];
    if (value === UNRANKED_COURT_RANK[field]) {
      continue;
    }
    const ids = idsByValue.get(value) ?? [];
    ids.push(id);
    idsByValue.set(value, ids);
  }
  return [...idsByValue]
    .toSorted(([left], [right]) => right - left)
    .map(([value, ids]) => ({ value, ids: courtIdArrayLiteral(ids) }));
};

let rankGroupsByField: Record<RankField, readonly RankGroup[]> | null = null;

/** Built once per process: the directory is fixed at build time. */
const usRankGroups = (field: RankField): readonly RankGroup[] => {
  rankGroupsByField ??= {
    tier: rankGroups("tier"),
    weight: rankGroups("weight"),
  };
  return rankGroupsByField[field];
};

/**
 * `usCourtRank`'s tier or weight as SQL over a court id column: one branch
 * per rank value, testing membership in the accepted ids holding it. The ids
 * travel as bound `text[]` parameters, so the statement text stays the same
 * size whatever the directory holds, and each `IN (SELECT unnest(...))` is an
 * uncorrelated subquery Postgres hashes once per statement, so a row's
 * lookup does not scan the list.
 *
 * A NULL or unaccepted id takes the ELSE, the unranked rank: never a name
 * pattern and never another jurisdiction's rank. The table CHECK keeps a
 * directory row's id non-null and the write boundary admits accepted ids
 * only, so a stored row reaches the ELSE only through corruption, and
 * `decisionCourtWeight` panics on the same row in TypeScript.
 */
export const usCourtRankSql = (courtIdColumn: string, field: RankField): SQL =>
  sqlCaseFragment({
    branches: usRankGroups(field).map(
      ({ value, ids }) =>
        sql`WHEN ${sql.raw(courtIdColumn)} IN (SELECT unnest(${ids}::text[])) THEN ${sql.raw(String(value))}`,
    ),
    fallback: sql.raw(String(UNRANKED_COURT_RANK[field])),
  });
