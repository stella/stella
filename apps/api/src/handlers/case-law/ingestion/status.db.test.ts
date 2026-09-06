import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { getIngestionStatus } from "@/api/handlers/case-law/ingestion/status";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The report reads every per-source figure with one grouped statement, so the
 * numbers are only right if each row lands against its own source. Two seeded
 * sources with deliberately different counts is the smallest arrangement that
 * can catch a group key going astray; a single-source fixture cannot.
 */

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the handler expects.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

const busyId = createSafeId<"caseLawSource">();
const quietId = createSafeId<"caseLawSource">();

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60 * 1000);

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
    { id: busyId, adapterKey: ADAPTER_KEYS.CZ_REGIONAL, name: "busy source" },
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
  const status = await getIngestionStatus(scopedDb);

  const busy = status.sources.find((source) => source.name === "busy source");
  const quiet = status.sources.find((source) => source.name === "quiet source");

  expect(busy?.totalDecisions).toBe(3);
  expect(quiet?.totalDecisions).toBe(1);

  expect(busy?.insertedLastHour).toBe(5);
  expect(busy?.inserted24h).toBe(12);
  expect(quiet?.insertedLastHour).toBe(1);
  expect(quiet?.inserted24h).toBe(1);

  expect(busy?.failures24h).toBe(3);
  expect(quiet?.failures24h).toBe(1);

  expect(status.totalDecisions).toBe(4);
  expect(status.totalEvents).toBe(3);
  expect(status.failures24h).toBe(4);
});

test("the last event is the source's own newest run", async () => {
  const status = await getIngestionStatus(scopedDb);

  const busy = status.sources.find((source) => source.name === "busy source");
  const quiet = status.sources.find((source) => source.name === "quiet source");

  expect(busy?.lastEvent?.inserted).toBe(5);
  expect(busy?.lastEvent?.status).toBe("completed");
  expect(busy?.lastEvent?.failed).toBe(false);
  expect(quiet?.lastEvent?.inserted).toBe(1);
});

test("top error types are ranked within each source", async () => {
  const status = await getIngestionStatus(scopedDb);

  const busy = status.sources.find((source) => source.name === "busy source");
  const quiet = status.sources.find((source) => source.name === "quiet source");

  expect(busy?.topErrors).toEqual([
    { errorType: "parse", count: 2 },
    { errorType: "fetch", count: 1 },
  ]);
  expect(quiet?.topErrors).toEqual([{ errorType: "fetch", count: 1 }]);
});

test("reconciliation totals are grouped per source", async () => {
  const status = await getIngestionStatus(scopedDb);

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
