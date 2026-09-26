/**
 * The ranks a court can hold, and the rank a directory court holds by its
 * directory tier. The seed renders its name rows from these
 * (`court-weight-seed.ts`); a directory court is ranked by its id alone, in
 * TypeScript by `usCourtRank` and in SQL by `usCourtRankSql`, both read from
 * the one directory.
 */
import {
  resolveUsCourt,
  US_COURT_BY_CANONICAL_NAME,
  US_COURTS,
  type UsCourtTier,
} from "@stll/api-contract/us-courts";

import { LOWEST_COURT_TIER } from "@/api/lib/legal-search/rerank";
import { sqlCaseExpression } from "@/api/lib/sql-case-expression";

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

/** A `text[]` literal of directory ids, each element quoted and escaped. */
const courtIdArrayLiteral = (ids: readonly string[]): string => {
  const elements = ids.map(
    (id) => `"${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return `'{${elements.join(",").replaceAll("'", "''")}}'::text[]`;
};

const renderUsCourtRankSql = (
  courtIdColumn: string,
  field: RankField,
): string => {
  const unranked = UNRANKED_COURT_RANK[field];
  const idsByValue = new Map<number, string[]>();
  for (const { id, tier } of US_COURTS) {
    const value = US_TIER_RANK[tier][field];
    // A group at the unranked value is what the ELSE answers already.
    if (value === unranked) {
      continue;
    }
    const ids = idsByValue.get(value) ?? [];
    ids.push(id);
    idsByValue.set(value, ids);
  }
  return sqlCaseExpression({
    branches: [...idsByValue]
      .toSorted(([left], [right]) => right - left)
      .map(
        ([value, ids]) =>
          `WHEN ${courtIdColumn} = ANY(${courtIdArrayLiteral(ids)}) THEN ${String(value)}`,
      ),
    fallback: unranked,
  });
};

const usCourtRankSqlCache = new Map<string, string>();

/**
 * `usCourtRank`'s tier or weight as SQL over a court id column: one
 * `= ANY(text[])` branch per rank value, listing the accepted ids holding it.
 * The directory holds thousands of ids and four tiers, so the rendering is
 * grouped by value rather than a branch per court, and cached per column.
 *
 * A NULL or unaccepted id takes the ELSE, the unranked rank: never a name
 * pattern and never another jurisdiction's rank. The table CHECK keeps a
 * directory row's id non-null and the write boundary admits accepted ids
 * only, so a stored row reaches the ELSE only through corruption, and
 * `decisionCourtWeight` panics on the same row in TypeScript.
 */
export const usCourtRankSql = (
  courtIdColumn: string,
  field: RankField,
): string => {
  const key = `${field}:${courtIdColumn}`;
  const cached = usCourtRankSqlCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const rendered = renderUsCourtRankSql(courtIdColumn, field);
  usCourtRankSqlCache.set(key, rendered);
  return rendered;
};
