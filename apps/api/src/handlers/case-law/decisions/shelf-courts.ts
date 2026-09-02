import { sql } from "drizzle-orm";

import {
  type CourtWeightEntry,
  loadCourtWeightsForCountry,
} from "@/api/handlers/case-law/court-weights";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * Which courts the entry shelf shows: the jurisdiction's apex courts by
 * declared rank, never its busiest courts by volume. Rank comes from the
 * seeded court weights (`constitutional` above `supreme` above `regional`);
 * the shelf keeps the top two labels, so a first-instance court with the
 * largest docket cannot own the page.
 */

const SHELF_TIER_LABELS: ReadonlySet<string> = new Set([
  "constitutional",
  "supreme",
]);

/** How many stored spellings of one apex court the candidate bound allows for. */
const SHELF_SPELLINGS_PER_COURT = 3;

export type CourtCount = {
  court: string;
  count: number;
};

export type ShelfCourt = {
  court: string;
  tierLabel: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Drivers disagree: bun-sql returns the rows, pglite wraps them in `{ rows }`. */
const rowsOf = (result: unknown): Record<string, unknown>[] => {
  let rows: unknown = result;
  if (!Array.isArray(result) && isRecord(result)) {
    rows = result["rows"];
  }
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
};

type ReadCourtCountsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
};

/**
 * Every court of the jurisdiction with its decision count. Deliberately
 * join-free: the statement is a parallel index-only walk of the
 * `(country, court, date)` index (planner cost 550k for the largest
 * jurisdiction, against 1.4M with a bitmap heap scan once the sources table
 * is joined in for `source_id`). Source policy is applied by the shelf
 * statement that follows, which drops a court whose public rows are none;
 * the cap on shown courts is taken after that, so a withheld court cannot
 * hold a slot. The counts only order courts within a tier.
 */
export const readCourtCounts = async ({
  caseLawDb,
  country,
}: ReadCourtCountsOptions): Promise<CourtCount[]> => {
  const result: unknown = await caseLawDb(
    async (tx) =>
      await tx.execute(sql`
        SELECT d.court, count(*)::int AS decision_count
        FROM case_law_decisions d
        WHERE d.country = ${country}
        GROUP BY d.court
      `),
  );
  return rowsOf(result).flatMap((row) => {
    const court = row["court"];
    return typeof court === "string" && court.length > 0
      ? [{ court, count: Number(row["decision_count"]) || 0 }]
      : [];
  });
};

type SelectShelfCourtsOptions = {
  counts: readonly CourtCount[];
  /** Sorted by tier descending, the order `loadCourtWeights` guarantees. */
  entries: readonly CourtWeightEntry[];
  limit: number;
};

const rankOf = (
  court: string,
  entries: readonly CourtWeightEntry[],
): CourtWeightEntry | undefined =>
  entries.find((entry) => entry.pattern.test(court));

/** A deterministic tie-break on the stored name; display order is not linguistic here. */
const byCodePoint = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * Apex courts first by tier, then by docket size within a tier, capped at
 * `limit`. A court no entry matches, or one whose label is below the shelf,
 * is left out.
 */
export const selectShelfCourts = ({
  counts,
  entries,
  limit,
}: SelectShelfCourtsOptions): ShelfCourt[] =>
  counts
    .flatMap(({ court, count }) => {
      const rank = rankOf(court, entries);
      return rank !== undefined && SHELF_TIER_LABELS.has(rank.tierLabel)
        ? [{ court, count, tier: rank.tier, tierLabel: rank.tierLabel }]
        : [];
    })
    .toSorted(
      (a, b) =>
        b.tier - a.tier || b.count - a.count || byCodePoint(a.court, b.court),
    )
    .slice(0, limit)
    .map(({ court, tierLabel }) => ({ court, tierLabel }));

/**
 * The rank entries the shelf ranks a jurisdiction's courts by: the seeded
 * weights, which the seed migration guarantees for every jurisdiction the
 * seed declares. A jurisdiction outside the seed has no rank and therefore
 * no shelf; that is logged, because it means the seed is behind the corpus.
 */
export const loadShelfCourtEntries = async (
  country: string,
): Promise<readonly CourtWeightEntry[]> => {
  const entries = await loadCourtWeightsForCountry(country);
  if (entries.length === 0) {
    logger.warn("case_law.latest_decisions.court_weights_unseeded", {
      country,
    });
  }
  return entries;
};

type ReadShelfCourtsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
  entries: readonly CourtWeightEntry[];
};

/** The shelf's courts for a jurisdiction, ranked by the given entries. */
export const readShelfCourts = async ({
  caseLawDb,
  country,
  entries,
}: ReadShelfCourtsOptions): Promise<ShelfCourt[]> => {
  const counts = await readCourtCounts({ caseLawDb, country });
  // Candidates, not the shown set: a publisher spells an apex court several
  // ways, and the shelf statement drops the spellings with no public rows
  // before the caller caps what it shows.
  const courts = selectShelfCourts({
    counts,
    entries,
    limit: LIMITS.caseLawLatestCourts * SHELF_SPELLINGS_PER_COURT,
  });
  if (courts.length === 0 && counts.length > 0) {
    // Rows exist but none rank as an apex court: a seed or a court-name
    // spelling has drifted from the corpus. The page shows no shelf rather
    // than a wrong one, and this is the only trace of why.
    logger.warn("case_law.latest_decisions.no_apex_court", {
      country,
      courts: counts.length,
    });
  }
  return courts;
};
