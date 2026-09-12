import { sql } from "drizzle-orm";

import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  type CourtWeightEntry,
  loadCourtWeightsForCountry,
} from "@/api/lib/case-law/court-weights";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import type { FacetBucket } from "@/api/lib/search/types";

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

/**
 * A court of the jurisdiction with the docket size the browse facets report
 * for it. The count orders courts within a tier and nothing else: it never
 * decides which courts exist. The facets hold only the jurisdiction's largest
 * `LIMITS.caseLawFacetLimit` courts, so a court with no bucket counts as zero
 * and orders after its tier's bucketed courts, then by name.
 */
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

type ReadCourtNamesOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
};

/**
 * Every court spelling the jurisdiction holds, by loose index scan: one
 * `min(court)` per distinct court, each a descent of the
 * `(country, court, date)` index. 611 buffers and 3.5 ms on the production
 * reader, for a jurisdiction with 116 courts.
 *
 * `GROUP BY court` is what this replaces, and its planner cost said nothing:
 * priced as a cheap parallel index-only scan, it reads every index entry of
 * the country and, where the pages are not all-visible, falls back to the
 * heap — 216k heap fetches, 966,716 shared buffers, 284 ms warm and ~11 s
 * cold, on every five-minute cache miss. The lateral that follows touches
 * 261 buffers, so the count was the whole cold cost, and cold it exceeded the
 * page's 10 s critical-query timeout.
 *
 * Join-free by design: source policy is applied by the shelf statement that
 * follows, which drops a court whose public rows are none; the cap on shown
 * courts is taken after that, so a withheld court cannot hold a slot.
 */
const readCourtNames = async ({
  caseLawDb,
  country,
}: ReadCourtNamesOptions): Promise<string[]> => {
  const result: unknown = await caseLawDb(
    async (tx) =>
      await tx.execute(sql`
        WITH RECURSIVE court_walk AS (
          SELECT min(d.court) AS court
          FROM case_law_decisions d
          WHERE d.country = ${country}
          UNION ALL
          SELECT (
            SELECT min(d.court)
            FROM case_law_decisions d
            WHERE d.country = ${country}
              AND d.court > court_walk.court
          )
          FROM court_walk
          WHERE court_walk.court IS NOT NULL
        )
        SELECT court_walk.court
        FROM court_walk
        WHERE court_walk.court IS NOT NULL
      `),
  );
  return rowsOf(result).flatMap((row) => {
    const court = row["court"];
    return typeof court === "string" && court.length > 0 ? [court] : [];
  });
};

type CourtDocketSizesOptions = {
  /** Every court the table holds; presence on the shelf is decided here alone. */
  courts: readonly string[];
  /** The browse facets' `court` buckets: the largest courts, exact counts. */
  buckets: readonly FacetBucket[];
};

/** Each court with its facet count, zero for a court the buckets do not name. */
export const courtDocketSizes = ({
  courts,
  buckets,
}: CourtDocketSizesOptions): CourtCount[] => {
  const countByCourt = new Map(
    buckets.map(({ value, count }) => [value, count]),
  );
  return courts.map((court) => ({
    court,
    count: countByCourt.get(court) ?? 0,
  }));
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
 * Apex courts first by tier, then by docket size within a tier, then by name,
 * capped at `limit`. A court no entry matches, or one whose label is below the
 * shelf, is left out. An uncounted court is ordered last within its tier, never
 * dropped: the count ranks courts, it does not admit them.
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
  /**
   * The jurisdiction's browse facets, whose `court` buckets order the shelf
   * within a tier. It degrades to empty facets, and the shelf then lists the
   * same courts in name order.
   */
  readFacets: (country: string) => Promise<LegalBrowseFacets>;
};

/** The shelf's courts for a jurisdiction, ranked by the given entries. */
export const readShelfCourts = async ({
  caseLawDb,
  country,
  entries,
  readFacets,
}: ReadShelfCourtsOptions): Promise<ShelfCourt[]> => {
  const [courts, facets] = await Promise.all([
    readCourtNames({ caseLawDb, country }),
    readFacets(country),
  ]);
  const counts = courtDocketSizes({ courts, buckets: facets.court });
  // Candidates, not the shown set: a publisher spells an apex court several
  // ways, and the shelf statement drops the spellings with no public rows
  // before the caller caps what it shows.
  const shelf = selectShelfCourts({
    counts,
    entries,
    limit: LIMITS.caseLawLatestCourts * SHELF_SPELLINGS_PER_COURT,
  });
  if (shelf.length === 0 && counts.length > 0) {
    // Rows exist but none rank as an apex court: a seed or a court-name
    // spelling has drifted from the corpus. The page shows no shelf rather
    // than a wrong one, and this is the only trace of why.
    logger.warn("case_law.latest_decisions.no_apex_court", {
      country,
      courts: counts.length,
    });
  }
  return shelf;
};
