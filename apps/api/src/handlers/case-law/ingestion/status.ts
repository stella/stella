import { Result } from "better-result";
import { count, desc, gte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  caseLawDecisions,
  caseLawIngestionEvents,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { DAY_IN_MS } from "@/api/lib/time";

type SourceStatus = {
  adapterKey: string;
  name: string;
  enabled: boolean;
  syncCursor: string | null;
  totalDecisions: number;
  insertedLastHour: number;
  inserted24h: number;
  failures24h: number;
  lastEvent: {
    status: string;
    inserted: number;
    skipped: number;
    durationMs: number;
    finishedAt: string;
    errorMessage: string | null;
  } | null;
  topErrors: { errorType: string; count: number }[];
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
    const sources = await db
      .select({
        id: caseLawSources.id,
        adapterKey: caseLawSources.adapterKey,
        name: caseLawSources.name,
        syncCursor: caseLawSources.syncCursor,
        enabled: caseLawSources.enabled,
      })
      .from(caseLawSources)
      // SAFETY: one row per ADAPTER_KEYS entry, enforced by the unique case_law_sources_adapter_key_idx
      // eslint-disable-next-line require-query-limit/require-query-limit
      .orderBy(caseLawSources.adapterKey);

    const sourceStatuses: SourceStatus[] = [];

    for (const source of sources) {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [totalRow] = await db
        .select({ total: count() })
        .from(caseLawDecisions)
        .where(sql`${caseLawDecisions.sourceId} = ${source.id}`);

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [hourRow] = await db
        .select({
          inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
        })
        .from(caseLawIngestionEvents)
        .where(
          sql`${caseLawIngestionEvents.sourceId} = ${source.id}
            AND ${caseLawIngestionEvents.finishedAt} >= ${oneHourAgo}`,
        );

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [dayRow] = await db
        .select({
          inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
        })
        .from(caseLawIngestionEvents)
        .where(
          sql`${caseLawIngestionEvents.sourceId} = ${source.id}
            AND ${caseLawIngestionEvents.finishedAt} >= ${oneDayAgo}`,
        );

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
      const [failRow] = await db
        .select({ total: count() })
        .from(caseLawIngestionFailures)
        .where(
          sql`${caseLawIngestionFailures.sourceId} = ${source.id}
            AND ${caseLawIngestionFailures.createdAt} >= ${oneDayAgo}`,
        );

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
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

      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential per-source aggregation reads on a single scoped connection
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

      sourceStatuses.push({
        adapterKey: source.adapterKey,
        name: source.name,
        enabled: source.enabled,
        syncCursor: source.syncCursor,
        totalDecisions: totalRow?.total ?? 0,
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
              errorMessage: lastEvent.errorMessage,
            }
          : null,
        topErrors: topFailures.map((f) => ({
          errorType: f.errorType,
          count: f.count,
        })),
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
  // Operator-only ingestion observability: `auditLog: ["read"]` is held solely
  // by owner/admin (see `packages/permissions`), matching the admin/owner gate
  // this route used to carry as a route-level `onBeforeHandle`. Declaring it in
  // the handler config means the safe-handler wrapper enforces it for BOTH the
  // REST route and the generic `invoke_capability` path, so neither bypasses the
  // gate. Keep this as the single source of the role check for this endpoint.
  permissions: { auditLog: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
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
