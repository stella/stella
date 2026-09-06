import { panic, Result } from "better-result";
import { and, count, desc, gte, inArray, lte, max, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawDecisions,
  caseLawIngestionEvents,
  caseLawIngestionFailures,
  caseLawReconciliationItems,
  caseLawSources,
  RECONCILIATION_ITEM_STATUS,
} from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { boundedAll } from "@/api/lib/db/bounded-all";
import {
  CASE_LAW_SOURCE_ROWS_BOUND,
  CASE_LAW_SOURCE_ROWS_INVARIANT,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  createUnrecognizedSourceReporter,
  sourceRegistryMembership,
} from "@/api/lib/legal-search/source-registry-membership";

/**
 * Where the standing listing reconciliation stands for one source.
 *
 * Null for a source it has never touched. The handler cannot see adapters, so
 * it cannot ask whether a source has the capability; the absence of both a
 * ledger row and a parked item is the same answer either way — nothing has
 * been reconciled here.
 */
type SourceReconciliationStatus = {
  /** Slices surveyed at least once. */
  slices: number;
  /** Of those, slices holding fewer identities than the publisher listed. */
  shortSlices: number;
  /** Of those, slices whose last listing walk failed; retried daily. */
  failedSlices: number;
  /** Listed decisions awaiting another attempt. */
  parked: number;
  /** Listed decisions the retry schedule gave up on; accounted for, not held. */
  terminal: number;
  lastCheckedAt: string | null;
};

type SourceStatus = {
  adapterKey: string;
  /**
   * False when no adapter is registered for `adapterKey`: a retired source, or
   * a seeded/test row. The corpus figures below are still that row's own, but
   * nothing will ingest into it, which is not visible from the numbers alone.
   */
  adapterRegistered: boolean;
  name: string;
  enabled: boolean;
  syncCursor: string | null;
  totalDecisions: number;
  /**
   * What the publisher reports holding, when that was observed, and where
   * the number came from. Null until the source has been measured; the three
   * always move together (see `ingestion/source-totals.ts`).
   */
  reportedTotal: number | null;
  reportedTotalAsOf: string | null;
  reportedTotalOrigin: SourceTotalOrigin | null;
  insertedLastHour: number;
  inserted24h: number;
  failures24h: number;
  /**
   * The last ingestion run for this source. Deliberately no error text: a
   * failure message is verbatim publisher or driver output, so the failure is
   * reported as `status` here and as the classified `topErrors` below.
   */
  lastEvent: {
    status: string;
    inserted: number;
    skipped: number;
    durationMs: number;
    finishedAt: string;
    failed: boolean;
  } | null;
  topErrors: { errorType: string; count: number }[];
  reconciliation: SourceReconciliationStatus | null;
};

type IngestionStatus = {
  sources: SourceStatus[];
  totalDecisions: number;
  totalEvents: number;
  failures24h: number;
};

/** Error types reported per source, ranked by occurrences in the last day. */
const TOP_ERROR_TYPES_PER_SOURCE = 3;

/**
 * Everything the report says about one source beyond its own row. Every field
 * has a zero value, so a source no grouped read matched still reports the
 * figures it had before: nothing, rather than a hole.
 */
type SourceAggregate = {
  decisions: number;
  insertedLastHour: number;
  inserted24h: number;
  failures24h: number;
  topErrors: SourceStatus["topErrors"];
  lastEvent: SourceStatus["lastEvent"];
  slices: number;
  shortSlices: number;
  failedSlices: number;
  lastCheckedAt: string | null;
  parked: number;
  terminal: number;
};

type SourceAggregates = Map<string, SourceAggregate>;

const emptyAggregate = (): SourceAggregate => ({
  decisions: 0,
  insertedLastHour: 0,
  inserted24h: 0,
  failures24h: 0,
  topErrors: [],
  lastEvent: null,
  slices: 0,
  shortSlices: 0,
  failedSlices: 0,
  lastCheckedAt: null,
  parked: 0,
  terminal: 0,
});

/**
 * Every source the caller asked about has an entry, because the map is seeded
 * from the same id list the reads are filtered by. A miss is a defect in that
 * pairing rather than a state a caller could handle.
 */
const requireAggregate = (
  aggregates: SourceAggregates,
  sourceId: SafeId<"caseLawSource">,
): SourceAggregate =>
  aggregates.get(sourceId) ??
  panic(`Ingestion status read no aggregate slot for source ${sourceId}`);

/**
 * Every per-source figure as one grouped read, so the report costs a fixed
 * number of statements however many sources exist.
 *
 * The reads run one after another rather than concurrently: a scoped-db
 * callback holds a single transaction connection, which carries one in-flight
 * statement at a time.
 */
const readSourceAggregates = async ({
  db,
  oneDayAgo,
  oneHourAgo,
  sourceIds,
}: {
  db: Transaction;
  oneDayAgo: Date;
  oneHourAgo: Date;
  sourceIds: SafeId<"caseLawSource">[];
}): Promise<SourceAggregates> => {
  if (sourceIds.length === 0) {
    return new Map();
  }

  const decisionRows = await db
    .select({ sourceId: caseLawDecisions.sourceId, total: count() })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.sourceId, sourceIds))
    .groupBy(caseLawDecisions.sourceId);

  // Both cutoffs are cast in SQL so the comparison happens at the column's own
  // precision rather than at the millisecond a JS Date carries.
  const dayCutoff = sql`${oneDayAgo}::timestamptz`;
  const hourCutoff = sql`${oneHourAgo}::timestamptz`;

  // The hour window is a subset of the day window, so one pass over the day's
  // events answers both: the filter narrows the sum, the row set stays shared.
  const insertedRows = await db
    .select({
      sourceId: caseLawIngestionEvents.sourceId,
      lastHour: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}) filter (where ${caseLawIngestionEvents.finishedAt} >= ${hourCutoff}), 0)::int`,
      lastDay: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)::int`,
    })
    .from(caseLawIngestionEvents)
    .where(
      and(
        inArray(caseLawIngestionEvents.sourceId, sourceIds),
        gte(caseLawIngestionEvents.finishedAt, dayCutoff),
      ),
    )
    .groupBy(caseLawIngestionEvents.sourceId);

  const failureRows = await db
    .select({ sourceId: caseLawIngestionFailures.sourceId, total: count() })
    .from(caseLawIngestionFailures)
    .where(
      and(
        inArray(caseLawIngestionFailures.sourceId, sourceIds),
        gte(caseLawIngestionFailures.createdAt, dayCutoff),
      ),
    )
    .groupBy(caseLawIngestionFailures.sourceId);

  // Ranking inside the database keeps "top N per source" one statement; a
  // plain group-by would have to ship every error type to rank it here.
  const rankedFailures = db
    .select({
      sourceId: caseLawIngestionFailures.sourceId,
      errorType: caseLawIngestionFailures.errorType,
      total: count().as("error_type_total"),
      rank: sql<number>`row_number() over (partition by ${caseLawIngestionFailures.sourceId} order by count(*) desc)`.as(
        "error_type_rank",
      ),
    })
    .from(caseLawIngestionFailures)
    .where(
      and(
        inArray(caseLawIngestionFailures.sourceId, sourceIds),
        gte(caseLawIngestionFailures.createdAt, dayCutoff),
      ),
    )
    .groupBy(
      caseLawIngestionFailures.sourceId,
      caseLawIngestionFailures.errorType,
    )
    .as("ranked_failures");

  const topErrorRows = await db
    .select({
      sourceId: rankedFailures.sourceId,
      errorType: rankedFailures.errorType,
      total: rankedFailures.total,
    })
    .from(rankedFailures)
    .where(lte(rankedFailures.rank, TOP_ERROR_TYPES_PER_SOURCE))
    .orderBy(rankedFailures.sourceId, rankedFailures.rank)
    .limit(sourceIds.length * TOP_ERROR_TYPES_PER_SOURCE);

  const lastEventRows = await db
    .selectDistinctOn([caseLawIngestionEvents.sourceId], {
      sourceId: caseLawIngestionEvents.sourceId,
      status: caseLawIngestionEvents.status,
      inserted: caseLawIngestionEvents.inserted,
      skipped: caseLawIngestionEvents.skipped,
      durationMs: caseLawIngestionEvents.durationMs,
      finishedAt: caseLawIngestionEvents.finishedAt,
      errorMessage: caseLawIngestionEvents.errorMessage,
    })
    .from(caseLawIngestionEvents)
    .where(inArray(caseLawIngestionEvents.sourceId, sourceIds))
    .orderBy(
      caseLawIngestionEvents.sourceId,
      desc(caseLawIngestionEvents.finishedAt),
    )
    .limit(sourceIds.length);

  const coverageRows = await db
    .select({
      sourceId: caseLawCoverageSlices.sourceId,
      // Surveyed means listed at least once; a row that only ever failed
      // is counted under `failedSlices` alone.
      slices: sql<number>`coalesce(sum(case when ${caseLawCoverageSlices.reported} is not null then 1 else 0 end), 0)::int`,
      shortSlices: sql<number>`coalesce(sum(case when ${caseLawCoverageSlices.collected} < ${caseLawCoverageSlices.reported} then 1 else 0 end), 0)::int`,
      failedSlices: sql<number>`coalesce(sum(case when ${caseLawCoverageSlices.walkError} is not null then 1 else 0 end), 0)::int`,
      // `max()` rather than raw SQL: drizzle then decodes the column with its
      // own timestamp mapper instead of handing back whatever the driver
      // returns for an untyped expression.
      lastCheckedAt: max(caseLawCoverageSlices.checkedAt),
    })
    .from(caseLawCoverageSlices)
    .where(inArray(caseLawCoverageSlices.sourceId, sourceIds))
    .groupBy(caseLawCoverageSlices.sourceId);

  const reconciliationItemRows = await db
    .select({
      sourceId: caseLawReconciliationItems.sourceId,
      parked: sql<number>`coalesce(sum(case when ${caseLawReconciliationItems.status} = ${RECONCILIATION_ITEM_STATUS.PARKED} then 1 else 0 end), 0)::int`,
      terminal: sql<number>`coalesce(sum(case when ${caseLawReconciliationItems.status} = ${RECONCILIATION_ITEM_STATUS.TERMINAL} then 1 else 0 end), 0)::int`,
    })
    .from(caseLawReconciliationItems)
    .where(inArray(caseLawReconciliationItems.sourceId, sourceIds))
    .groupBy(caseLawReconciliationItems.sourceId);

  const aggregates: SourceAggregates = new Map(
    sourceIds.map((sourceId) => [sourceId, emptyAggregate()]),
  );

  for (const row of decisionRows) {
    requireAggregate(aggregates, row.sourceId).decisions = row.total;
  }
  for (const row of insertedRows) {
    const aggregate = requireAggregate(aggregates, row.sourceId);
    aggregate.insertedLastHour = row.lastHour;
    aggregate.inserted24h = row.lastDay;
  }
  for (const row of failureRows) {
    requireAggregate(aggregates, row.sourceId).failures24h = row.total;
  }
  for (const row of topErrorRows) {
    requireAggregate(aggregates, row.sourceId).topErrors.push({
      errorType: row.errorType,
      count: row.total,
    });
  }
  for (const row of lastEventRows) {
    requireAggregate(aggregates, row.sourceId).lastEvent = {
      status: row.status,
      inserted: row.inserted,
      skipped: row.skipped,
      durationMs: row.durationMs,
      finishedAt: row.finishedAt.toISOString(),
      failed: row.errorMessage !== null,
    };
  }
  for (const row of coverageRows) {
    const aggregate = requireAggregate(aggregates, row.sourceId);
    aggregate.slices = row.slices;
    aggregate.shortSlices = row.shortSlices;
    aggregate.failedSlices = row.failedSlices;
    aggregate.lastCheckedAt = row.lastCheckedAt?.toISOString() ?? null;
  }
  for (const row of reconciliationItemRows) {
    const aggregate = requireAggregate(aggregates, row.sourceId);
    aggregate.parked = row.parked;
    aggregate.terminal = row.terminal;
  }

  return aggregates;
};

export const getIngestionStatus = async (
  scopedDb: ScopedDb,
): Promise<IngestionStatus> => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - DAY_IN_MS);

  return await scopedDb(async (db) => {
    const sources = await boundedAll({
      invariant: CASE_LAW_SOURCE_ROWS_INVARIANT,
      max: CASE_LAW_SOURCE_ROWS_BOUND,
      table: "case_law_sources",
      query: (limit) =>
        db
          .select({
            id: caseLawSources.id,
            adapterKey: caseLawSources.adapterKey,
            name: caseLawSources.name,
            syncCursor: caseLawSources.syncCursor,
            enabled: caseLawSources.enabled,
            reportedTotal: caseLawSources.reportedTotal,
            reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
            reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
          })
          .from(caseLawSources)
          .orderBy(caseLawSources.adapterKey)
          .limit(limit),
    });

    const aggregates = await readSourceAggregates({
      db,
      oneDayAgo,
      oneHourAgo,
      sourceIds: sources.map((source) => source.id),
    });

    const sourceStatuses: SourceStatus[] = [];
    const reportUnrecognizedSource = createUnrecognizedSourceReporter(
      "case_law.ingestion_status",
    );

    for (const source of sources) {
      const aggregate = requireAggregate(aggregates, source.id);
      const reconciliation: SourceReconciliationStatus | null =
        aggregate.slices === 0 &&
        aggregate.parked === 0 &&
        aggregate.terminal === 0
          ? null
          : {
              slices: aggregate.slices,
              shortSlices: aggregate.shortSlices,
              failedSlices: aggregate.failedSlices,
              parked: aggregate.parked,
              terminal: aggregate.terminal,
              lastCheckedAt: aggregate.lastCheckedAt,
            };

      const membership = sourceRegistryMembership(source.adapterKey);
      if (membership.type === "unrecognized") {
        reportUnrecognizedSource(source.adapterKey);
      }

      sourceStatuses.push({
        adapterKey: source.adapterKey,
        adapterRegistered: membership.type === "registered",
        name: source.name,
        enabled: source.enabled,
        syncCursor: source.syncCursor,
        totalDecisions: aggregate.decisions,
        reportedTotal: source.reportedTotal,
        reportedTotalAsOf: source.reportedTotalAsOf?.toISOString() ?? null,
        reportedTotalOrigin: source.reportedTotalOrigin,
        insertedLastHour: aggregate.insertedLastHour,
        inserted24h: aggregate.inserted24h,
        failures24h: aggregate.failures24h,
        lastEvent: aggregate.lastEvent,
        topErrors: aggregate.topErrors,
        reconciliation,
      });
    }

    const [totalDecisions] = await db
      .select({ total: count() })
      .from(caseLawDecisions);

    const [totalEvents] = await db
      .select({ total: count() })
      .from(caseLawIngestionEvents);

    const [totalFailures] = await db
      .select({ total: count() })
      .from(caseLawIngestionFailures)
      .where(gte(caseLawIngestionFailures.createdAt, oneDayAgo));

    return {
      sources: sourceStatuses,
      totalDecisions: totalDecisions?.total ?? 0,
      totalEvents: totalEvents?.total ?? 0,
      failures24h: totalFailures?.total ?? 0,
    };
  });
};

const config = {
  description:
    "Report case-law corpus ingestion health for operators. Per source: " +
    "adapter key and whether an adapter is still registered for it, enabled " +
    "flag, sync cursor, decisions held against the total the publisher " +
    "reports, decisions inserted in the last hour and last day, failures and " +
    "the top error types in the last day, the last ingestion event, and " +
    "standing reconciliation counts (slices surveyed, short slices, parked " +
    "and terminal items). Requires organization audit-log access.",
  // Operator-only ingestion observability: `auditLog: ["read"]` is held solely
  // by owner/admin (see `packages/permissions`), matching the admin/owner gate
  // this route used to carry as a route-level `onBeforeHandle`. Declaring it in
  // the handler config means the safe-handler wrapper enforces it for BOTH the
  // REST route and the generic `invoke_capability` path, so neither bypasses the
  // gate. Keep this as the single source of the role check for this endpoint.
  permissions: { auditLog: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  access: "read",
} satisfies HandlerConfig;

const getCaseLawIngestionStatus = createSafeRootHandler(
  config,
  async function* ({ scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(async () => await getIngestionStatus(scopedDb)),
    );

    return Result.ok(response);
  },
);

export default getCaseLawIngestionStatus;
