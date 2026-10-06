import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@stll/api-contract/case-law-court-tiers";
import {
  isDecisionTypeKind,
  type DecisionTypeKind,
} from "@stll/api-contract/case-law-decision-types";
import {
  FACET_COUNT_TYPE,
  type FacetCountType,
} from "@stll/api-contract/search";

import { caseLawSources } from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  courtTierLabelFromMap,
  type CourtWeightMap,
} from "@/api/lib/case-law/court-weights";
import { decisionTypeKind } from "@/api/lib/case-law/decision-type-kind";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawSourceId } from "@/api/lib/safe-id-boundaries";

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

export type SourceFacetBucket = SearchFacetBucket & {
  countType: FacetCountType;
};

/** Convert a capped N+1 probe into its exact count or lower bound. */
export const cappedSourceFacetBuckets = (
  buckets: readonly SearchFacetBucket[],
): SourceFacetBucket[] =>
  buckets.map((bucket) =>
    bucket.count > LIMITS.caseLawSourceFacetCountCap
      ? {
          ...bucket,
          count: LIMITS.caseLawSourceFacetCountCap,
          countType: FACET_COUNT_TYPE.AT_LEAST,
        }
      : { ...bucket, countType: FACET_COUNT_TYPE.EXACT },
  );

type SearchCourtTier = {
  tierLabel: CourtTierLabel;
  courts: SearchFacetBucket[];
};

export type DecisionSearchFacets = {
  court: SearchCourtTier[];
  year: SearchFacetBucket[];
  decisionType: DecisionTypeFacetBucket[];
  source: SourceFacetBucket[];
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

/** A type facet bucket: its value is a canonical kind, never a stated spelling. */
type DecisionTypeFacetBucket = Omit<SearchFacetBucket, "value"> & {
  value: DecisionTypeKind;
};

/**
 * The type facet from stated spellings (`usn.`, `usnesení`), as the corpus
 * index aggregates them: each folded into the kind it states, counts summed,
 * the list cut only after the fold. Summing is exact because a decision version
 * states one type, so no version sits in two spellings' buckets. A spelling no
 * kind claims lands in the catch-all kind rather than reaching a reader raw.
 */
export const foldStatedDecisionTypeBuckets = (
  buckets: readonly SearchFacetBucket[],
): DecisionTypeFacetBucket[] => {
  const counts = new Map<DecisionTypeKind, number>();
  for (const { value, count } of buckets) {
    const kind = decisionTypeKind(value);
    counts.set(kind, (counts.get(kind) ?? 0) + count);
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: null, count }))
    .toSorted(compareFacetBuckets)
    .slice(0, LIMITS.caseLawFacetLimit);
};

/**
 * The type facet the Postgres statement already grouped by kind
 * (`decisionTypeKindSql`), whose values are kinds by construction: a value
 * that is not one is a broken statement, not data.
 */
export const decisionTypeKindBuckets = (
  buckets: readonly SearchFacetBucket[],
): DecisionTypeFacetBucket[] =>
  buckets.map(({ value, label, count }) => ({
    value: isDecisionTypeKind(value)
      ? value
      : panic(`Decision type facet grouped by a non-kind: ${value}`),
    label,
    count,
  }));

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
      .toSorted(compareFacetBuckets)
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
            sourceIds.map((id) => brandPersistedCaseLawSourceId(id)),
          ),
        ),
  );
  return new Map(rows.map((row) => [String(row.id), row.name]));
};

/** The source facet with every bucket's display name attached. */
export const labelSourceBuckets = <TBucket extends SearchFacetBucket>(
  buckets: readonly TBucket[],
  nameById: ReadonlyMap<string, string>,
) =>
  buckets.map((bucket) => ({
    ...bucket,
    label: nameById.get(bucket.value) ?? null,
  }));
