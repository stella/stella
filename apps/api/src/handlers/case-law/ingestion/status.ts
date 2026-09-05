import { Result } from "better-result";
import { count, desc, gte, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

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

    const sourceStatuses: SourceStatus[] = [];
    const reportUnrecognizedSource = createUnrecognizedSourceReporter(
      "case_law.ingestion_status",
    );

    for (const source of sources) {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential by design: single scoped-db transaction client, must not be parallelized
      const [totalRow] = await db
        .select({ total: count() })
        .from(caseLawDecisions)
        .where(sql`${caseLawDecisions.sourceId} = ${source.id}`);

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [hourRow] = await db
        .select({
          inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)::int`,
        })
        .from(caseLawIngestionEvents)
        .where(
          sql`${caseLawIngestionEvents.sourceId} = ${source.id}
            AND ${caseLawIngestionEvents.finishedAt} >= ${oneHourAgo}`,
        );

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [dayRow] = await db
        .select({
          inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)::int`,
        })
        .from(caseLawIngestionEvents)
        .where(
          sql`${caseLawIngestionEvents.sourceId} = ${source.id}
            AND ${caseLawIngestionEvents.finishedAt} >= ${oneDayAgo}`,
        );

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [failRow] = await db
        .select({ total: count() })
        .from(caseLawIngestionFailures)
        .where(
          sql`${caseLawIngestionFailures.sourceId} = ${source.id}
            AND ${caseLawIngestionFailures.createdAt} >= ${oneDayAgo}`,
        );

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [lastEvent] = await db
        .select({
          status: caseLawIngestionEvents.status,
          inserted: caseLawIngestionEvents.inserted,
          skipped: caseLawIngestionEvents.skipped,
          durationMs: caseLawIngestionEvents.durationMs,
          finishedAt: caseLawIngestionEvents.finishedAt,
          errorMessage: caseLawIngestionEvents.errorMessage,
        })
        .from(caseLawIngestionEvents)
        .where(sql`${caseLawIngestionEvents.sourceId} = ${source.id}`)
        .orderBy(desc(caseLawIngestionEvents.finishedAt))
        .limit(1);

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const topFailures = await db
        .select({
          errorType: caseLawIngestionFailures.errorType,
          count: count(),
        })
        .from(caseLawIngestionFailures)
        .where(
          sql`${caseLawIngestionFailures.sourceId} = ${source.id}
            AND ${caseLawIngestionFailures.createdAt} >= ${oneDayAgo}`,
        )
        .groupBy(caseLawIngestionFailures.errorType)
        .orderBy(desc(count()))
        .limit(3);

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [sliceRow] = await db
        .select({
          // Surveyed means listed at least once; a row that only ever failed
          // is counted under `failedSlices` alone.
          slices: sql<number>`coalesce(sum(case when ${caseLawCoverageSlices.reported} is not null then 1 else 0 end), 0)::int`,
          shortSlices: sql<number>`coalesce(sum(case when ${caseLawCoverageSlices.collected} < ${caseLawCoverageSlices.reported} then 1 else 0 end), 0)::int`,
          failedSlices: sql<number>`coalesce(sum(case when ${caseLawCoverageSlices.walkError} is not null then 1 else 0 end), 0)::int`,
          lastCheckedAt: sql<Date | null>`max(${caseLawCoverageSlices.checkedAt})`,
        })
        .from(caseLawCoverageSlices)
        .where(sql`${caseLawCoverageSlices.sourceId} = ${source.id}`);

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [itemRow] = await db
        .select({
          parked: sql<number>`coalesce(sum(case when ${caseLawReconciliationItems.status} = ${RECONCILIATION_ITEM_STATUS.PARKED} then 1 else 0 end), 0)::int`,
          terminal: sql<number>`coalesce(sum(case when ${caseLawReconciliationItems.status} = ${RECONCILIATION_ITEM_STATUS.TERMINAL} then 1 else 0 end), 0)::int`,
        })
        .from(caseLawReconciliationItems)
        .where(sql`${caseLawReconciliationItems.sourceId} = ${source.id}`);

      const slices = sliceRow?.slices ?? 0;
      const parked = itemRow?.parked ?? 0;
      const terminal = itemRow?.terminal ?? 0;
      const reconciliation: SourceReconciliationStatus | null =
        slices === 0 && parked === 0 && terminal === 0
          ? null
          : {
              slices,
              shortSlices: sliceRow?.shortSlices ?? 0,
              failedSlices: sliceRow?.failedSlices ?? 0,
              parked,
              terminal,
              lastCheckedAt: sliceRow?.lastCheckedAt?.toISOString() ?? null,
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
        totalDecisions: totalRow?.total ?? 0,
        reportedTotal: source.reportedTotal,
        reportedTotalAsOf: source.reportedTotalAsOf?.toISOString() ?? null,
        reportedTotalOrigin: source.reportedTotalOrigin,
        insertedLastHour: hourRow?.inserted ?? 0,
        inserted24h: dayRow?.inserted ?? 0,
        failures24h: failRow?.total ?? 0,
        lastEvent: lastEvent
          ? {
              status: lastEvent.status,
              inserted: lastEvent.inserted,
              skipped: lastEvent.skipped,
              durationMs: lastEvent.durationMs,
              finishedAt: lastEvent.finishedAt.toISOString(),
              failed: lastEvent.errorMessage !== null,
            }
          : null,
        topErrors: topFailures.map((f) => ({
          errorType: f.errorType,
          count: f.count,
        })),
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
