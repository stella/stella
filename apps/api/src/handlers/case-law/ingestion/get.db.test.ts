import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
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
  relations,
} from "@/api/db/schema";
import {
  getIngestionStatus,
  latestIngestionEventsQuery,
  reconciliationCountsQuery,
} from "@/api/handlers/case-law/ingestion/get";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Two seeded sources with different counts catch a group key going astray.
 */

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  await db.transaction(
    async (tx) =>
      // SAFETY: PGlite has the same transaction query contract as the handler.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite transaction stands in for Bun SQL
      await callback(tx as unknown as Transaction),
  );

const busyId = createSafeId<"caseLawSource">();
const quietId = createSafeId<"caseLawSource">();

const FIXED_NOW = new Date("2026-09-28T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(FIXED_NOW.getTime() - minutes * 60 * 1000);
const readStatus = async () =>
  await getIngestionStatus(scopedDb, { now: FIXED_NOW });

const planLines = (explained: unknown): string[] => {
  const rows =
    typeof explained === "object" && explained !== null && "rows" in explained
      ? explained.rows
      : explained;
  if (!Array.isArray(rows)) {
    return panic("EXPLAIN did not return plan rows");
  }
  return rows.map((row: unknown) => {
    const line = isRecord(row) ? row["QUERY PLAN"] : undefined;
    return typeof line === "string"
      ? line
      : panic("EXPLAIN row has no plan text");
  });
};

const decision = (sourceId: SafeId<"caseLawSource">, ordinal: number) => ({
  sourceId,
  id: createSafeId<"caseLawDecision">(),
  court: "Krajský soud",
  country: "CZE",
  language: "cs",
  caseNumber: `11 C ${ordinal}/2025`,
  citationKey: `11c/${ordinal}/2025`,
  decisionDate: "2025-03-01",
  slug: `decision-${ordinal}`,
  languageGroupKey: `decision-${ordinal}`,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);

  await db.insert(caseLawSources).values([
    {
      id: busyId,
      adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
      name: "busy source",
      // Deliberately behind the three rows below: the report must carry the
      // counted figure, not recount.
      storedTotal: 2,
      storedTotalAsOf: minutesAgo(90),
    },
    { id: quietId, adapterKey: ADAPTER_KEYS.CZ_NS, name: "quiet source" },
  ]);

  await db
    .insert(caseLawDecisions)
    .values([
      decision(busyId, 1),
      decision(busyId, 2),
      decision(busyId, 3),
      decision(quietId, 4),
    ]);

  await db.insert(caseLawIngestionEvents).values([
    {
      sourceId: busyId,
      status: "completed",
      inserted: 5,
      skipped: 1,
      durationMs: 100,
      startedAt: minutesAgo(30),
      finishedAt: minutesAgo(29),
    },
    {
      // Inside the day window, outside the hour window.
      sourceId: busyId,
      status: "failed",
      inserted: 7,
      skipped: 2,
      durationMs: 200,
      errorMessage: "publisher timeout",
      startedAt: minutesAgo(300),
      finishedAt: minutesAgo(299),
    },
    {
      sourceId: quietId,
      status: "completed",
      inserted: 1,
      skipped: 0,
      durationMs: 50,
      startedAt: minutesAgo(10),
      finishedAt: minutesAgo(9),
    },
  ]);

  await db.insert(caseLawIngestionFailures).values([
    {
      sourceId: busyId,
      caseNumber: "11 C 1/2025",
      errorType: "parse",
      errorMessage: "bad document",
      createdAt: minutesAgo(20),
    },
    {
      sourceId: busyId,
      caseNumber: "11 C 2/2025",
      errorType: "parse",
      errorMessage: "bad document",
      createdAt: minutesAgo(21),
    },
    {
      sourceId: busyId,
      caseNumber: "11 C 3/2025",
      errorType: "fetch",
      errorMessage: "timeout",
      createdAt: minutesAgo(22),
    },
    {
      sourceId: quietId,
      caseNumber: "22 C 1/2025",
      errorType: "fetch",
      errorMessage: "timeout",
      createdAt: minutesAgo(23),
    },
  ]);

  await db.insert(caseLawCoverageSlices).values([
    { sourceId: busyId, slice: "2025-03-01", reported: 10, collected: 4 },
    { sourceId: busyId, slice: "2025-03-02", reported: 3, collected: 3 },
    { sourceId: busyId, slice: "2025-03-03", walkError: "listing refused" },
  ]);

  await db.insert(caseLawReconciliationItems).values([
    {
      sourceId: busyId,
      slice: "2025-03-01",
      identityKey: "document:1",
      payload: {},
      status: RECONCILIATION_ITEM_STATUS.PARKED,
      nextAttemptAt: minutesAgo(-60),
    },
    {
      sourceId: busyId,
      slice: "2025-03-01",
      identityKey: "document:2",
      payload: {},
      status: RECONCILIATION_ITEM_STATUS.TERMINAL,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
});

test("per-source figures stay with their own source", async () => {
  const report = await readStatus();

  const busy = report.sources.find((source) => source.name === "busy source");
  const quiet = report.sources.find((source) => source.name === "quiet source");

  expect(busy?.totalDecisions).toBe(2);
  expect(busy?.totalDecisionsAsOf).toBe(minutesAgo(90).toISOString());
  expect(quiet?.totalDecisions).toBeNull();
  expect(quiet?.totalDecisionsAsOf).toBeNull();

  expect(busy?.insertedLastHour).toBe(5);
  expect(busy?.inserted24h).toBe(12);
  expect(quiet?.insertedLastHour).toBe(1);
  expect(quiet?.inserted24h).toBe(1);

  expect(busy?.failures24h).toBe(3);
  expect(quiet?.failures24h).toBe(1);

  // One source uncounted: no fleet total rather than a short one.
  expect(report.totalDecisions).toBeNull();
  expect(report.estimatedTotalEvents).toBeGreaterThanOrEqual(0);
  expect(report.failures24h).toBe(4);
});

test("the fleet total is the sum once every source is counted", async () => {
  await db
    .update(caseLawSources)
    .set({ storedTotal: 1, storedTotalAsOf: minutesAgo(5) })
    .where(eq(caseLawSources.id, quietId));

  const status = await readStatus();

  expect(status.totalDecisions).toBe(3);
});

test("the last event is the source's own newest run", async () => {
  const status = await readStatus();

  const busy = status.sources.find((source) => source.name === "busy source");
  const quiet = status.sources.find((source) => source.name === "quiet source");

  expect(busy?.lastEvent?.inserted).toBe(5);
  expect(busy?.lastEvent?.status).toBe("completed");
  expect(busy?.lastEvent?.failed).toBe(false);
  expect(quiet?.lastEvent?.inserted).toBe(1);
});

test("top error types are ranked within each source", async () => {
  const status = await readStatus();

  const busy = status.sources.find((source) => source.name === "busy source");
  const quiet = status.sources.find((source) => source.name === "quiet source");

  expect(busy?.topErrors).toEqual([
    { errorType: "parse", count: 2 },
    { errorType: "fetch", count: 1 },
  ]);
  expect(quiet?.topErrors).toEqual([{ errorType: "fetch", count: 1 }]);
});

test("reconciliation totals are grouped per source", async () => {
  const status = await readStatus();

  const busy = status.sources.find((source) => source.name === "busy source");
  const quiet = status.sources.find((source) => source.name === "quiet source");

  expect(busy?.reconciliation).toMatchObject({
    slices: 2,
    shortSlices: 1,
    failedSlices: 1,
    parked: 1,
    terminal: 1,
  });
  expect(quiet?.reconciliation).toBeNull();
});

test("the fleet event estimate is labelled and follows table statistics", async () => {
  await db.execute(sql`ANALYZE case_law_ingestion_events`);
  const report = await readStatus();

  expect(report.estimatedTotalEvents).toBe(3);
  expect(report).not.toHaveProperty("totalEvents");
});

test("latest-event and reconciliation reads use their per-source indexes", async () => {
  await db.execute(sql`
    INSERT INTO case_law_sources (id, adapter_key, name)
    SELECT gen_random_uuid(), 'plan-' || i, 'plan-' || i
    FROM generate_series(1, 50) AS i
  `);
  await db.execute(sql`
    INSERT INTO case_law_ingestion_events
      (id, source_id, status, duration_ms, started_at, finished_at)
    SELECT gen_random_uuid(), s.id, 'completed', 1,
      ${FIXED_NOW}::timestamptz - interval '2 minutes',
      ${FIXED_NOW}::timestamptz - interval '1 minute' + i * interval '1 millisecond'
    FROM case_law_sources AS s
    CROSS JOIN generate_series(1, 30) AS i
    WHERE s.adapter_key LIKE 'plan-%'
  `);
  await db.execute(sql`ANALYZE case_law_ingestion_events`);
  await db.execute(sql`VACUUM case_law_ingestion_events`);

  const plans = await scopedDb(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    await tx.execute(sql`SET LOCAL seq_page_cost = 100`);
    await tx.execute(sql`SET LOCAL random_page_cost = 100`);

    const sources = [busyId, quietId];
    const latest = await tx.execute(
      sql`EXPLAIN ${latestIngestionEventsQuery(tx, sources).getSQL()}`,
    );
    const reconciliation = await tx.execute(
      sql`EXPLAIN ${reconciliationCountsQuery(tx, sources).getSQL()}`,
    );
    return { latest, reconciliation };
  });

  const latestPlan = planLines(plans.latest).join("\n");
  const reconciliationPlan = planLines(plans.reconciliation).join("\n");
  expect(latestPlan).toContain(
    "Index Only Scan using case_law_ingestion_events_source_finished_idx",
  );
  expect(latestPlan).toContain("Limit");
  expect(latestPlan).not.toContain("Seq Scan on case_law_ingestion_events");
  expect(reconciliationPlan).toContain(
    "Index Only Scan using case_law_reconciliation_items_slice_idx",
  );
});
