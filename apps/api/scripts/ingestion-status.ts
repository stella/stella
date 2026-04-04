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

import { count, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawIngestionEvents,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";

const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);
const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);

const sources = await db
  .select({
    id: caseLawSources.id,
    adapterKey: caseLawSources.adapterKey,
    name: caseLawSources.name,
    syncCursor: caseLawSources.syncCursor,
    lastSyncAt: caseLawSources.lastSyncAt,
    enabled: caseLawSources.enabled,
  })
  .from(caseLawSources)
  .orderBy(caseLawSources.adapterKey);

if (sources.length === 0) {
  console.log("No sources configured.");
  process.exit(0);
}

console.log("\n=== Case Law Ingestion Status ===\n");

for (const source of sources) {
  // Total decisions for this source
  const [totalRow] = await db
    .select({ total: count() })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, source.id));

  // Decisions inserted in last hour
  const [hourRow] = await db
    .select({
      inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
    })
    .from(caseLawIngestionEvents)
    .where(
      sql`${caseLawIngestionEvents.sourceId} = ${source.id}
        AND ${caseLawIngestionEvents.finishedAt} >= ${ONE_HOUR_AGO}`,
    );

  // Decisions inserted in last 24h
  const [dayRow] = await db
    .select({
      inserted: sql<number>`coalesce(sum(${caseLawIngestionEvents.inserted}), 0)`,
    })
    .from(caseLawIngestionEvents)
    .where(
      sql`${caseLawIngestionEvents.sourceId} = ${source.id}
        AND ${caseLawIngestionEvents.finishedAt} >= ${ONE_DAY_AGO}`,
    );

  // Recent failures count
  const [failRow] = await db
    .select({ total: count() })
    .from(caseLawIngestionFailures)
    .where(
      sql`${caseLawIngestionFailures.sourceId} = ${source.id}
        AND ${caseLawIngestionFailures.createdAt} >= ${ONE_DAY_AGO}`,
    );

  // Last event
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
    .where(eq(caseLawIngestionEvents.sourceId, source.id))
    .orderBy(desc(caseLawIngestionEvents.finishedAt))
    .limit(1);

  // Top failure types (last 24h)
  const topFailures = await db
    .select({
      errorType: caseLawIngestionFailures.errorType,
      count: count(),
    })
    .from(caseLawIngestionFailures)
    .where(
      sql`${caseLawIngestionFailures.sourceId} = ${source.id}
        AND ${caseLawIngestionFailures.createdAt} >= ${ONE_DAY_AGO}`,
    )
    .groupBy(caseLawIngestionFailures.errorType)
    .orderBy(desc(count()))
    .limit(3);

  const total = totalRow?.total ?? 0;
  const lastHour = Number(hourRow?.inserted ?? 0);
  const last24h = Number(dayRow?.inserted ?? 0);
  const failCount = failRow?.total ?? 0;
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
const [totalDecisions] = await db
  .select({ total: count() })
  .from(caseLawDecisions);

const [totalEvents] = await db
  .select({ total: count() })
  .from(caseLawIngestionEvents);

const [totalFailures] = await db
  .select({ total: count() })
  .from(caseLawIngestionFailures)
  .where(gte(caseLawIngestionFailures.createdAt, ONE_DAY_AGO));

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
