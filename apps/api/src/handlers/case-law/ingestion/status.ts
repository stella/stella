import { count, desc, gte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  caseLawDecisions,
  caseLawIngestionEvents,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";

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
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

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
      .orderBy(caseLawSources.adapterKey);

    const sourceStatuses: SourceStatus[] = [];

    for (const source of sources) {
      const [totalRow] = await db
        .select({ total: count() })
        .from(caseLawDecisions)
        .where(sql`${caseLawDecisions.sourceId} = ${source.id}`);

      const [hourRow] = await db
        .select({
          inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
        })
        .from(caseLawIngestionEvents)
        .where(
          sql`${caseLawIngestionEvents.sourceId} = ${source.id}
            AND ${caseLawIngestionEvents.finishedAt} >= ${oneHourAgo}`,
        );

      const [dayRow] = await db
        .select({
          inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
        })
        .from(caseLawIngestionEvents)
        .where(
          sql`${caseLawIngestionEvents.sourceId} = ${source.id}
            AND ${caseLawIngestionEvents.finishedAt} >= ${oneDayAgo}`,
        );

      const [failRow] = await db
        .select({ total: count() })
        .from(caseLawIngestionFailures)
        .where(
          sql`${caseLawIngestionFailures.sourceId} = ${source.id}
            AND ${caseLawIngestionFailures.createdAt} >= ${oneDayAgo}`,
        );

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
        insertedLastHour: Number(hourRow?.inserted ?? 0),
        inserted24h: Number(dayRow?.inserted ?? 0),
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
