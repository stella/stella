import { panic } from "better-result";
import { and, count, eq, gte, lte, or, sql } from "drizzle-orm";

import { chunk } from "@stll/concurrency/chunk";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCompletenessCensus as census,
  caseLawDecisions,
} from "@/api/db/schema";
import { loadAdapterByKey } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { censusCapabilityFor } from "@/api/lib/case-law/completeness-census-capabilities";
import {
  CENSUS_WORST_SLICES_LIMIT,
  CENSUS_YEAR_SUMMARIES_LIMIT,
  censusVerdictFromSummary,
} from "@/api/lib/case-law/completeness-census-contract";
import type { SourceCensus } from "@/api/lib/case-law/completeness-census-contract";
import { rowHoldsDocument } from "@/api/lib/case-law/stored-payload";
import { lockCaseLawSourceIngestionLease } from "@/api/lib/db/aggregate-lock";
import { CASE_LAW_SOURCE_ROWS_BOUND } from "@/api/lib/legal-search/ingestion-constants";
import type {
  ListingIdentity,
  SourceSliceWalk,
} from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import { createUnrecognizedSourceReporter } from "@/api/lib/legal-search/source-registry-membership";

const CENSUS_SCOPE_SLICE_LIMIT = 100_000;
const CENSUS_IDENTITY_BATCH_SIZE = 500;

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

/** Resolve the current publisher universe before opening the read transaction; no publisher calls. */
export const currentCensusSourceScopes = async (
  sources: readonly CensusSource[],
  now: Date,
): Promise<CurrentCensusSourceScope[]> =>
  await Promise.all(
    sources.map(async ({ id, adapterKey }) => {
      const adapter = await loadAdapterByKey(adapterKey);
      return {
        id,
        scope:
          adapter === undefined
            ? null
            : censusScope(adapter.reconciliation, now),
      };
    }),
  );

type RecordCensusOptions = {
  sourceId: SafeId<"caseLawSource">;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  adapterKey: string;
  slice: string;
  scope: ReturnType<typeof censusScope>;
  identities: readonly ListingIdentity[];
  /** Includes unkeyable entries: they must never vanish from the denominator. */
  listed: number;
  publisherCount: number | undefined;
  observedAt: Date;
};

/** The source lock fences stale workers; counts and observation commit together. */
export const recordCompletenessCensus = async (
  scopedDb: ScopedDb,
  options: RecordCensusOptions,
) => {
  const capability = censusCapabilityFor(options.adapterKey);
  if (capability === undefined) {
    createUnrecognizedSourceReporter("case_law.completeness_census")(
      options.adapterKey,
    );
    return;
  }
  const year = /^\d{4}/u.exec(options.slice)?.at(0);
  if (capability.type !== "none-exposed" && year === undefined) {
    panic(`Census slice lacks a year: ${options.adapterKey}/${options.slice}`);
  }
  const measuredOutcome =
    options.publisherCount === undefined
      ? "listing-enumerated"
      : "publisher-count";
  const outcome =
    capability.type === "none-exposed" ? capability.type : measuredOutcome;
  const publisherCount =
    outcome === "none-exposed"
      ? null
      : (options.publisherCount ?? options.listed);
  if (
    publisherCount !== null &&
    (!Number.isSafeInteger(publisherCount) || publisherCount < 0)
  ) {
    panic("Census publisher count is invalid");
  }
  await scopedDb(async (tx) => {
    if (
      !(await lockCaseLawSourceIngestionLease({
        tx,
        sourceId: options.sourceId,
        leaseToken: options.leaseToken,
      }))
    ) {
      return;
    }
    let storedCount = 0;
    let textCount = 0;
    for (const batch of chunk(options.identities, CENSUS_IDENTITY_BATCH_SIZE)) {
      const incoming = batch.map((identity) => ({
        key: listingIdentityKey(identity),
        documentId:
          identity.type === "document" ? identity.sourceDocumentId : null,
        caseNumber:
          identity.type === "case-number" ? identity.caseNumber : null,
        language: identity.type === "case-number" ? identity.language : null,
      }));
      // db-await-in-loop: bounded identity batches in one short observation transaction
      const rows = await tx
        .select({
          key: sql<string>`incoming.key`,
          withText: sql<boolean>`bool_or(${rowHoldsDocument})`,
        })
        .from(caseLawDecisions)
        .innerJoin(
          sql`jsonb_to_recordset(${JSON.stringify(incoming)}::text::jsonb) AS incoming(key text, "documentId" text, "caseNumber" text, language text)`,
          sql`(${caseLawDecisions.sourceDocumentId} = incoming."documentId" OR (${caseLawDecisions.sourceDocumentId} IS NULL AND ${caseLawDecisions.caseNumber} = incoming."caseNumber" AND ${caseLawDecisions.language} = incoming.language))`,
        )
        .where(eq(caseLawDecisions.sourceId, options.sourceId))
        .groupBy(sql`incoming.key`)
        .limit(batch.length);
      storedCount += rows.length;
      textCount += rows.filter(({ withText }) => withText).length;
    }
    const observation = {
      sourceId: options.sourceId,
      slice: options.slice,
      year: year === undefined || Number(year) === 0 ? null : Number(year),
      outcome,
      scopeStatus:
        capability.type === "none-exposed"
          ? "partial-publisher"
          : capability.scopeStatus,
      publisherCount,
      storedCount,
      textCount,
      observedAt: options.observedAt,
      scopeFirst: options.scope.first,
      scopeLast: options.scope.last,
      expectedSlices: options.scope.expectedSlices,
      evidenceRef: capability.evidenceRef,
    } as const satisfies typeof census.$inferInsert;
    // audit: skip — public-corpus sweep observation under the source ingestion lease
    await tx
      .insert(census)
      .values(observation)
      .onConflictDoUpdate({
        target: [census.sourceId, census.slice],
        set: observation,
        setWhere: sql`${census.observedAt} <= ${options.observedAt.toISOString()}::timestamptz`,
      });
  });
};

export const unmeasuredSourceCensus = (adapterKey: string): SourceCensus => ({
  verdict: "unmeasured",
  scopeStatus: "partial-publisher",
  outcome: censusCapabilityFor(adapterKey)?.type ?? "none-exposed",
  evidenceRef:
    censusCapabilityFor(adapterKey)?.evidenceRef ?? "unregistered-adapter",
  measuredSlices: 0,
  expectedSlices: null,
  shortSlices: 0,
  publisher: null,
  stored: 0,
  withText: 0,
  observedAt: null,
  years: [],
  worstSlices: [],
});

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
  const totals = await tx
    .select({
      sourceId: census.sourceId,
      measured: count(),
      unknown: sql<number>`count(*) FILTER (WHERE ${census.outcome} = 'none-exposed' OR ${census.scopeStatus} = 'partial-publisher')::int`,
      noneExposed: sql<number>`count(*) FILTER (WHERE ${census.outcome} = 'none-exposed')::int`,
      partial: sql<number>`count(*) FILTER (WHERE ${census.scopeStatus} = 'partial-publisher')::int`,
      stated: sql<number>`count(*) FILTER (WHERE ${census.outcome} = 'publisher-count')::int`,
      short: sql<number>`count(*) FILTER (WHERE ${short})::int`,
      publisher: sql<
        number | null
      >`sum(${census.publisherCount})::bigint`.mapWith(
        (value: string | null) => (value === null ? null : Number(value)),
      ),
      stored: sql<number>`sum(${census.storedCount})::bigint`.mapWith(Number),
      withText: sql<number>`sum(${census.textCount})::bigint`.mapWith(Number),
      observedAt: sql<string>`min(${census.observedAt})::text`,
      evidenceRef: sql<string>`min(${census.evidenceRef})`,
    })
    .from(census)
    .where(where)
    .groupBy(census.sourceId)
    .limit(CASE_LAW_SOURCE_ROWS_BOUND);
  const years = await tx
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
    .orderBy(census.sourceId, census.year)
    .limit(CASE_LAW_SOURCE_ROWS_BOUND * CENSUS_YEAR_SUMMARIES_LIMIT);
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
  const worst = await tx
    .select()
    .from(ranked)
    .where(sql`${ranked.rank} <= ${CENSUS_WORST_SLICES_LIMIT}`)
    .limit(CASE_LAW_SOURCE_ROWS_BOUND * CENSUS_WORST_SLICES_LIMIT);
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
