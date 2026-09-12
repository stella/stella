import { inArray } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands source ids the index returned before reading their names back
import { toSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
  courtTierLabelFromMap,
  type CourtWeightMap,
} from "@/api/lib/case-law/court-weights";

/**
 * What a search's filter rail is made of, on both providers.
 *
 * Every count is a number of DECISIONS under the request's other filters —
 * each facet omits its own, so selecting a value inside one facet never empties
 * the others. The corpus index stores passages rather than decisions, so its
 * side of this counts distinct decision ids rather than hits; the Postgres side
 * counts judgments rather than language versions. Neither ever reports the
 * storage unit as the count.
 */
export type SearchFacetBucket = {
  value: string;
  /** Display name, when `value` is an identifier a reader should not see. */
  label: string | null;
  count: number;
};

type SearchCourtTier = {
  tierLabel: CourtTierLabel;
  courts: SearchFacetBucket[];
};

export type DecisionSearchFacets = {
  court: SearchCourtTier[];
  year: SearchFacetBucket[];
  decisionType: SearchFacetBucket[];
  source: SearchFacetBucket[];
  language: SearchFacetBucket[];
};

/**
 * Code-unit order over a facet value. Deliberately not a collator: a facet
 * value is an identifier, and a locale-sensitive comparison would make the
 * order of a page depend on the reader's language.
 */
const compareValue = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * Most decisions first, the value breaking the tie. The tie-break is what
 * makes a facet reproducible: two buckets of equal size otherwise swap places
 * between requests for no reason a reader can see.
 */
export const compareFacetBuckets = (
  a: SearchFacetBucket,
  b: SearchFacetBucket,
): number => b.count - a.count || compareValue(a.value, b.value);

/** Newest year first; the values are civil years, so the order is numeric. */
export const compareYearBuckets = (
  a: SearchFacetBucket,
  b: SearchFacetBucket,
): number => Number(b.value) - Number(a.value);

type GroupCourtsByTierOptions = {
  buckets: readonly SearchFacetBucket[];
  /** Scopes the pattern match; court names repeat across borders. */
  country: string;
  courtWeights: CourtWeightMap;
  /**
   * Courts listed under one tier. The cap belongs here rather than on the read
   * that produced `buckets`: capping before the grouping is what loses an apex
   * court to twenty district courts with longer dockets, and whether the
   * supreme court is listed must not depend on how much the district courts
   * published.
   */
  perTierLimit: number;
};

/**
 * Courts grouped by where they sit in their jurisdiction, apex first, biggest
 * bucket first within a tier, each tier capped. A tier no matched court
 * belongs to is left out rather than emitted empty: a reader narrowing a
 * result set is choosing among courts that answer the query, and an empty
 * heading is a dead row.
 */
export const groupCourtsByTier = ({
  buckets,
  country,
  courtWeights,
  perTierLimit,
}: GroupCourtsByTierOptions): SearchCourtTier[] => {
  const tierOf = new Map<string, CourtTierLabel>(
    buckets.map((bucket) => [
      bucket.value,
      courtTierLabelFromMap(courtWeights, bucket.value, country),
    ]),
  );
  return COURT_TIER_LABELS.flatMap((tierLabel) => {
    const courts = buckets
      .filter((bucket) => tierOf.get(bucket.value) === tierLabel)
      .sort(compareFacetBuckets)
      .slice(0, perTierLimit);
    return courts.length === 0 ? [] : [{ tierLabel, courts }];
  });
};

/**
 * Display names for the sources a facet lists, read through the public role's
 * column grants: `name` is the one human-readable column it may select.
 * A source the read does not answer for keeps a null label rather than
 * borrowing another source's.
 */
export const readCaseLawSourceNames = async (
  caseLawDb: CaseLawPublicReadDb,
  sourceIds: readonly string[],
): Promise<Map<string, string>> => {
  if (sourceIds.length === 0) {
    return new Map();
  }
  const rows = await caseLawDb(
    async (tx) =>
      await tx
        .select({ id: caseLawSources.id, name: caseLawSources.name })
        .from(caseLawSources)
        .where(
          inArray(
            caseLawSources.id,
            sourceIds.map((id) => toSafeId<"caseLawSource">(id)),
          ),
        ),
  );
  return new Map(rows.map((row) => [String(row.id), row.name]));
};

/** The source facet with every bucket's display name attached. */
export const labelSourceBuckets = (
  buckets: readonly SearchFacetBucket[],
  nameById: ReadonlyMap<string, string>,
): SearchFacetBucket[] =>
  buckets.map((bucket) => ({
    ...bucket,
    label: nameById.get(bucket.value) ?? null,
  }));
