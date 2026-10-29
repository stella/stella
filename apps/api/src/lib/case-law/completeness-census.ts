import { panic } from "better-result";
import { and, count, eq, gte, lte, or, sql } from "drizzle-orm";

import { caseLawCompletenessCensus as census } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { censusCapabilityFor } from "@/api/lib/case-law/completeness-census-capabilities";
import {
  CENSUS_WORST_SLICES_LIMIT,
  CENSUS_YEAR_SUMMARIES_LIMIT,
  censusVerdictFromSummary,
} from "@/api/lib/case-law/completeness-census-contract";
import type { SourceCensus } from "@/api/lib/case-law/completeness-census-contract";
import { CENSUS_AGGREGATE_UNIT } from "@/api/lib/case-law/completeness-census-values";
import { readBounded } from "@/api/lib/db/read-bounded";
import { CASE_LAW_SOURCE_ROWS_BOUND } from "@/api/lib/legal-search/ingestion-constants";
import type { SourceSliceWalk } from "@/api/lib/legal-search/ingestion-types";

const CENSUS_SCOPE_SLICE_LIMIT = 100_000;

type CensusScope = { first: string; last: string; expectedSlices: number };
// Reconstructed from the adapter walk: this cache only avoids repeating a historical coordinate walk per unit.
const scopeCache = new WeakMap<SourceSliceWalk, CensusScope>();

/** Enumerate coordinates in memory only; use the adapter's original, unfloored walk. */
export const censusScope = (walk: SourceSliceWalk, now: Date) => {
  const last = walk.sliceOf(now);
  const cached = scopeCache.get(walk);
  if (cached?.first === walk.firstSlice && cached.last === last) {
    return cached;
  }
  let current: string | null = last;
  let expectedSlices = 0;
  while (current !== null && current >= walk.firstSlice) {
    expectedSlices += 1;
    if (expectedSlices > CENSUS_SCOPE_SLICE_LIMIT) {
      panic("Census scope exceeds its slice bound");
    }
    if (current === walk.firstSlice) {
      const scope = { first: walk.firstSlice, last, expectedSlices };
      scopeCache.set(walk, scope);
      return scope;
    }
    const previous = walk.previousSlice(current);
    if (previous !== null && previous >= current) {
      panic("Census slice walk must decrease");
    }
    current = previous;
  }
  return panic("Census slice walk does not reach its first slice");
};

type CensusSource = { id: SafeId<"caseLawSource">; adapterKey: string };
export type CurrentCensusSourceScope = {
  id: SafeId<"caseLawSource">;
  scope: CensusScope | null;
};

type CurrentCensusSourceScopesOptions = {
  sources: readonly CensusSource[];
  now: Date;
  loadAdapter: (
    key: string,
  ) => Promise<{ reconciliation: SourceSliceWalk } | undefined>;
};

/** Resolve the current publisher universe before opening the read transaction; no publisher calls. */
export const currentCensusSourceScopes = async ({
  sources,
  now,
  loadAdapter,
}: CurrentCensusSourceScopesOptions): Promise<CurrentCensusSourceScope[]> =>
  await Promise.all(
    sources.map(async ({ id, adapterKey }) => {
      const adapter = await loadAdapter(adapterKey);
      return {
        id,
        scope:
          adapter === undefined
            ? null
            : censusScope(adapter.reconciliation, now),
      };
    }),
  );

export const unmeasuredSourceCensus = (adapterKey: string): SourceCensus => {
  const capability =
    censusCapabilityFor(adapterKey) ?? panic("Unregistered census adapter");
  return {
    aggregateUnit: CENSUS_AGGREGATE_UNIT,
    verdict: "unmeasured",
    scopeStatus: "partial-publisher",
    outcome: capability.type,
    evidenceRef: capability.evidenceRef,
    measuredSlices: 0,
    expectedSlices: null,
    shortSlices: 0,
    publisher: null,
    stored: 0,
    withText: 0,
    observedAt: null,
    years: [],
    worstSlices: [],
  };
};

const short = sql`${census.publisherCount} IS NOT NULL AND (${census.storedCount} < ${census.publisherCount} OR ${census.textCount}::bigint * 1000 < ${census.storedCount}::bigint * 999)`;

type CensusOutcomeSummary = {
  noneExposed: number;
  stated: number;
  measured: number;
};
const censusOutcomeFromSummary = ({
  noneExposed,
  stated,
  measured,
}: CensusOutcomeSummary): SourceCensus["outcome"] => {
  if (noneExposed > 0) {
    return "none-exposed";
  }
  return stated === measured ? "publisher-count" : "listing-enumerated";
};

/** Three indexed aggregates, bounded by the registry and response summary limits. */
export const readCompletenessCensusQuery = async (
  tx: CaseLawPublicReadTransaction,
  sources: readonly CurrentCensusSourceScope[],
): Promise<ReadonlyMap<string, SourceCensus>> => {
  if (sources.length === 0) {
    return new Map();
  }
  const scopes = new Map(sources.map(({ id, scope }) => [String(id), scope]));
  const where = or(
    ...sources.map(({ id, scope }) =>
      scope === null
        ? eq(census.sourceId, id)
        : and(
            eq(census.sourceId, id),
            gte(census.slice, scope.first),
            lte(census.slice, scope.last),
          ),
    ),
  );
  const totalsRead = await readBounded(
    tx
      .select({
        sourceId: census.sourceId,
        measured: count(),
        unknown: sql<number>`count(*) FILTER (WHERE ${census.outcome} = 'none-exposed' OR ${census.scopeExtent} = 'partial-publisher')::int`,
        noneExposed: sql<number>`count(*) FILTER (WHERE ${census.outcome} = 'none-exposed')::int`,
        partial: sql<number>`count(*) FILTER (WHERE ${census.scopeExtent} = 'partial-publisher')::int`,
        stated: sql<number>`count(*) FILTER (WHERE ${census.outcome} = 'publisher-count')::int`,
        short: sql<number>`count(*) FILTER (WHERE ${short})::int`,
        publisher: sql<
          number | null
        >`sum(${census.publisherCount})::bigint`.mapWith(Number),
        stored: sql<number>`sum(${census.storedCount})::bigint`.mapWith(Number),
        withText: sql<number>`sum(${census.textCount})::bigint`.mapWith(Number),
        observedAt: sql<string>`min(${census.observedAt})::text`,
        evidenceRef: sql<string>`min(${census.evidenceRef})`,
      })
      .from(census)
      .where(where)
      .groupBy(census.sourceId),
    CASE_LAW_SOURCE_ROWS_BOUND,
  );
  if (totalsRead.type === "overflow") {
    return panic("Census source aggregates exceed the registered source bound");
  }
  const totals = totalsRead.rows;
  const yearsRead = await readBounded(
    tx
      .select({
        sourceId: census.sourceId,
        year: census.year,
        slices: count(),
        publisher:
          sql<number>`coalesce(sum(${census.publisherCount}), 0)::bigint`.mapWith(
            Number,
          ),
        stored: sql<number>`sum(${census.storedCount})::bigint`.mapWith(Number),
        withText: sql<number>`sum(${census.textCount})::bigint`.mapWith(Number),
      })
      .from(census)
      .where(where)
      .groupBy(census.sourceId, census.year)
      .orderBy(census.sourceId, census.year),
    CASE_LAW_SOURCE_ROWS_BOUND * CENSUS_YEAR_SUMMARIES_LIMIT,
  );
  if (yearsRead.type === "overflow") {
    return panic("Census year aggregates exceed the response summary bound");
  }
  const years = yearsRead.rows;
  const ranked = tx
    .select({
      sourceId: census.sourceId,
      slice: census.slice,
      year: census.year,
      outcome: census.outcome,
      publisher: census.publisherCount,
      stored: census.storedCount,
      withText: census.textCount,
      observedAt: census.observedAt,
      evidenceRef: census.evidenceRef,
      rank: sql<number>`row_number() over (partition by ${census.sourceId} order by (${census.publisherCount} - ${census.storedCount}) desc nulls first, (${census.storedCount} - ${census.textCount}) desc, ${census.slice})`.as(
        "rank",
      ),
    })
    .from(census)
    .where(and(where, sql`(${short} OR ${census.outcome} = 'none-exposed')`))
    .as("ranked_census");
  const worstRead = await readBounded(
    tx
      .select()
      .from(ranked)
      .where(sql`${ranked.rank} <= ${CENSUS_WORST_SLICES_LIMIT}`),
    CASE_LAW_SOURCE_ROWS_BOUND * CENSUS_WORST_SLICES_LIMIT,
  );
  if (worstRead.type === "overflow") {
    return panic("Census worst slices exceed the response summary bound");
  }
  const worst = worstRead.rows;
  return new Map(
    totals.map((row) => {
      const scope = scopes.get(String(row.sourceId));
      if (scope === undefined) {
        return panic("Census aggregate has no current source scope");
      }
      const expectedSlices = scope?.expectedSlices ?? null;
      return [
        String(row.sourceId),
        {
          aggregateUnit: CENSUS_AGGREGATE_UNIT,
          verdict: censusVerdictFromSummary({
            measuredSlices: row.measured,
            expectedSlices,
            unmeasuredSlices: row.unknown,
            shortSlices: row.short,
          }),
          scopeStatus: row.partial > 0 ? "partial-publisher" : "full-publisher",
          outcome: censusOutcomeFromSummary(row),
          evidenceRef: row.evidenceRef,
          measuredSlices: row.measured,
          expectedSlices,
          shortSlices: row.short,
          publisher: row.noneExposed > 0 ? null : row.publisher,
          stored: row.stored,
          withText: row.withText,
          observedAt: new Date(row.observedAt).toISOString(),
          years: years
            .filter(
              ({ sourceId, year }) =>
                sourceId === row.sourceId && year !== null,
            )
            .flatMap(({ year, sourceId: _, ...rest }) =>
              year === null ? [] : [{ year, ...rest }],
            )
            .slice(0, CENSUS_YEAR_SUMMARIES_LIMIT),
          worstSlices: worst
            .filter(({ sourceId }) => sourceId === row.sourceId)
            .map(({ sourceId: _, rank: __, observedAt, ...slice }) => ({
              ...slice,
              observedAt: observedAt.toISOString(),
            })),
        } satisfies SourceCensus,
      ] as const;
    }),
  );
};
