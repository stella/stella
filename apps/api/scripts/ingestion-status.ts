/**
 * Print a dashboard of case law ingestion status.
 *
 * Queries the ingestion events and failures tables to show
 * per-adapter stats: total decisions, recent rate, failures,
 * cursor position, and last cycle time.
 *
 * Usage:
 *   bun apps/api/scripts/ingestion-status.ts
 */

import { count, desc, gte, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawIngestionEvents,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";

const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);
const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);

const { rootDb: db } = await openCaseLawReadOnlySession();

const sources = await db.transaction(
  async (tx) =>
    await tx
      .select({
        id: caseLawSources.id,
        adapterKey: caseLawSources.adapterKey,
        name: caseLawSources.name,
        syncCursor: caseLawSources.syncCursor,
        lastSyncAt: caseLawSources.lastSyncAt,
        enabled: caseLawSources.enabled,
      })
      .from(caseLawSources)
      .orderBy(caseLawSources.adapterKey),
);

if (sources.length === 0) {
  console.log("No sources configured.");
  process.exit(0);
}

console.log("\n=== Case Law Ingestion Status ===\n");

// Each figure is one grouped query over every source, not one per source.
const totalBySource = new Map(
  (
    await db.transaction(
      async (tx) =>
        await tx
          .select({ sourceId: caseLawDecisions.sourceId, total: count() })
          .from(caseLawDecisions)
          .groupBy(caseLawDecisions.sourceId),
    )
  ).map((row) => [row.sourceId, row.total]),
);

const insertedBySource = new Map(
  (
    await db.transaction(
      async (tx) =>
        await tx
          .select({
            sourceId: caseLawIngestionEvents.sourceId,
            lastHour: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}) FILTER (WHERE ${caseLawIngestionEvents.finishedAt} >= ${ONE_HOUR_AGO}), 0)`,
            lastDay: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
          })
          .from(caseLawIngestionEvents)
          .where(gte(caseLawIngestionEvents.finishedAt, ONE_DAY_AGO))
          .groupBy(caseLawIngestionEvents.sourceId),
    )
  ).map((row) => [row.sourceId, row]),
);

const failureCountBySource = new Map(
  (
    await db.transaction(
      async (tx) =>
        await tx
          .select({
            sourceId: caseLawIngestionFailures.sourceId,
            total: count(),
          })
          .from(caseLawIngestionFailures)
          .where(gte(caseLawIngestionFailures.createdAt, ONE_DAY_AGO))
          .groupBy(caseLawIngestionFailures.sourceId),
    )
  ).map((row) => [row.sourceId, row.total]),
);

const lastEventBySource = new Map(
  (
    await db.transaction(
      async (tx) =>
        await tx
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
          .orderBy(
            caseLawIngestionEvents.sourceId,
            desc(caseLawIngestionEvents.finishedAt),
          ),
    )
  ).map((row) => [row.sourceId, row]),
);

const TOP_FAILURE_TYPES = 3;
const topFailuresBySource = new Map<
  (typeof caseLawIngestionFailures.$inferSelect)["sourceId"],
  { errorType: string; count: number }[]
>();
const failureTypeCounts = await db.transaction(
  async (tx) =>
    await tx
      .select({
        sourceId: caseLawIngestionFailures.sourceId,
        errorType: caseLawIngestionFailures.errorType,
        count: count(),
      })
      .from(caseLawIngestionFailures)
      .where(gte(caseLawIngestionFailures.createdAt, ONE_DAY_AGO))
      .groupBy(
        caseLawIngestionFailures.sourceId,
        caseLawIngestionFailures.errorType,
      )
      .orderBy(caseLawIngestionFailures.sourceId, desc(count())),
);
for (const row of failureTypeCounts) {
  const top = topFailuresBySource.get(row.sourceId) ?? [];
  if (top.length < TOP_FAILURE_TYPES) {
    top.push({ errorType: row.errorType, count: row.count });
  }
  topFailuresBySource.set(row.sourceId, top);
}

for (const source of sources) {
  const total = totalBySource.get(source.id) ?? 0;
  const lastHour = insertedBySource.get(source.id)?.lastHour ?? 0;
  const last24h = insertedBySource.get(source.id)?.lastDay ?? 0;
  const failCount = failureCountBySource.get(source.id) ?? 0;
  const lastEvent = lastEventBySource.get(source.id);
  const topFailures = topFailuresBySource.get(source.id) ?? [];
  const enabledStr = source.enabled ? "" : " [DISABLED]";

  const timeSince = lastEvent?.finishedAt
    ? formatTimeSince(lastEvent.finishedAt)
    : "never";

  const lastStatus = lastEvent
    ? `${lastEvent.status === "completed" ? "✓" : "✗"} ${timeSince} (${lastEvent.durationMs}ms, +${lastEvent.inserted}/-${lastEvent.skipped})`
    : "no events";

  console.log(`${source.name} (${source.adapterKey})${enabledStr}`);
  console.log(`  Total:    ${total.toLocaleString()} decisions`);
  console.log(`  Last 1h:  +${lastHour.toLocaleString()}`);
  console.log(`  Last 24h: +${last24h.toLocaleString()}`);
  console.log(`  Failures: ${failCount} (24h)`);
  console.log(`  Cursor:   ${source.syncCursor ?? "(none)"}`);
  console.log(`  Last:     ${lastStatus}`);

  if (topFailures.length > 0) {
    console.log("  Top errors:");
    for (const f of topFailures) {
      console.log(`    ${f.errorType}: ${f.count}`);
    }
  }

  if (lastEvent?.errorMessage) {
    console.log(`  Error:    ${lastEvent.errorMessage.slice(0, 120)}`);
  }

  console.log();
}

// Summary
const [totalDecisions] = await db.transaction(
  async (tx) => await tx.select({ total: count() }).from(caseLawDecisions),
);

const [totalEvents] = await db.transaction(
  async (tx) =>
    await tx.select({ total: count() }).from(caseLawIngestionEvents),
);

const [totalFailures] = await db.transaction(
  async (tx) =>
    await tx
      .select({ total: count() })
      .from(caseLawIngestionFailures)
      .where(gte(caseLawIngestionFailures.createdAt, ONE_DAY_AGO)),
);

console.log("--- Summary ---");
console.log(
  `Total decisions: ${(totalDecisions?.total ?? 0).toLocaleString()}`,
);
console.log(`Total events:    ${(totalEvents?.total ?? 0).toLocaleString()}`);
console.log(`Failures (24h):  ${totalFailures?.total ?? 0}`);

process.exit(0);

function formatTimeSince(date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
