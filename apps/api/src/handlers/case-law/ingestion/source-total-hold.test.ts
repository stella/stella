import { panic } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  recordSourceStoredTotalUnknownHold,
  sourceStoredTotalHoldHeartbeat,
} from "./source-total-hold";
import { refreshSourceStoredTotal } from "./source-totals";

const NOW = new Date("2026-10-02T12:00:00Z");
let client: Awaited<ReturnType<typeof createTestPglite>>;
const connect = (
  databaseClient: Awaited<ReturnType<typeof createTestPglite>>,
) => drizzle({ client: databaseClient, relations: databaseRelations });
let db: ReturnType<typeof connect>;
const scopedDb: ScopedDb = async (fn) =>
  await db.transaction(async (tx) => await fn(asTestRaw<Transaction>(tx)));
beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);
afterAll(async () => {
  await client.close();
});
const seed = async () => {
  const id = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id,
    adapterKey: `unknown-hold-${id}`,
    name: "Unknown hold fixture",
    storedTotalNextRefreshAt: NOW,
  });
  return id;
};
const read = async (sourceId: SafeId<"caseLawSource">) => {
  const row = (
    await db
      .select({
        heldSince: caseLawSources.storedTotalHeldSince,
        warnedSlot: caseLawSources.storedTotalWarnedSlot,
        due: caseLawSources.storedTotalNextRefreshAt,
        attemptedAt: caseLawSources.storedTotalAttemptedAt,
        total: caseLawSources.storedTotal,
        asOf: caseLawSources.storedTotalAsOf,
      })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, sourceId))
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return panic("Missing source hold fixture");
  }
  return row;
};
const unknownRefresh = async (sourceId: SafeId<"caseLawSource">, now: Date) =>
  await refreshSourceStoredTotal({
    scopedDb,
    sourceId,
    readDatabaseNow: async () => now,
    acquireAdmission: async () => "unknown",
    countSource: async () => panic("UNKNOWN admission must not count"),
  });

test("UNKNOWN holds persist and warn once per source and durable slot across new refresh invocations", async () => {
  const first = await seed();
  const second = await seed();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(await unknownRefresh(first, NOW)).toBe("held");
    expect(await unknownRefresh(first, new Date(NOW.getTime() + 1000))).toBe(
      "held",
    );
    expect(await unknownRefresh(first, new Date(NOW.getTime() + 2000))).toBe(
      "held",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await read(first)).toEqual({
      heldSince: NOW,
      warnedSlot: NOW,
      due: NOW,
      attemptedAt: null,
      total: null,
      asOf: null,
    });
    expect(warn).toHaveBeenCalledWith(
      "case_law.source_stored_total.held_unknown",
      {
        sourceId: first,
        holdCause: "indicators_unavailable",
        slot: NOW.toISOString(),
      },
    );
    const secondHeldAt = new Date(NOW.getTime() + 3000);
    expect(await unknownRefresh(second, secondHeldAt)).toBe("held");
    expect(warn).toHaveBeenCalledTimes(2);
    expect((await read(second)).heldSince).toEqual(secondHeldAt);
    const nextSlot = new Date(NOW.getTime() + 4000);
    await db
      .update(caseLawSources)
      .set({ storedTotalNextRefreshAt: nextSlot })
      .where(eq(caseLawSources.id, first));
    expect(await unknownRefresh(first, new Date(NOW.getTime() + 5000))).toBe(
      "held",
    );
    expect(await unknownRefresh(first, new Date(NOW.getTime() + 6000))).toBe(
      "held",
    );
    expect(warn).toHaveBeenCalledTimes(3);
    const firstAfter = await read(first);
    expect(firstAfter.heldSince).toEqual(NOW);
    expect(firstAfter.warnedSlot).toEqual(nextSlot);
    expect(firstAfter.attemptedAt).toBeNull();
    expect((await read(second)).warnedSlot).toEqual(NOW);
  } finally {
    warn.mockRestore();
  }
});

test("a granted refresh clears the durable hold and a stale UNKNOWN result cannot restore it", async () => {
  const sourceId = await seed();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let finishUnknown: (() => void) | undefined;
  let enteredUnknown: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredUnknown = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finishUnknown = resolve;
  });
  let oldUnknown: ReturnType<typeof refreshSourceStoredTotal> | undefined;
  try {
    expect(await unknownRefresh(sourceId, NOW)).toBe("held");
    oldUnknown = refreshSourceStoredTotal({
      scopedDb,
      sourceId,
      readDatabaseNow: async () => NOW,
      acquireAdmission: async () => {
        enteredUnknown?.();
        await release;
        return "unknown";
      },
      countSource: async () => panic("UNKNOWN admission must not count"),
    });
    await entered;
    const grantedAt = new Date(NOW.getTime() + 1000);
    expect(
      await refreshSourceStoredTotal({
        scopedDb,
        sourceId,
        readDatabaseNow: async () => grantedAt,
        acquireAdmission: async () => "granted",
        countSource: async () => 17,
      }),
    ).toBe("refreshed");
    const granted = await read(sourceId);
    expect(granted.heldSince).toBeNull();
    expect(granted.total).toBe(17);
    expect(granted.asOf).toEqual(grantedAt);
    expect(granted.attemptedAt).toEqual(grantedAt);
    expect(granted.due?.getTime()).toBeGreaterThan(grantedAt.getTime());
    finishUnknown?.();
    expect(await oldUnknown).toBe("held");
    expect(await read(sourceId)).toEqual(granted);
    await recordSourceStoredTotalUnknownHold({
      scopedDb,
      sourceId,
      now: new Date(grantedAt.getTime() + 1000),
      slot: NOW,
    });
    expect(await read(sourceId)).toEqual(granted);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    finishUnknown?.();
    await oldUnknown;
    warn.mockRestore();
  }
});

test("the EMF hold gauge exposes the yielded alarm contract and clears after a grant", () => {
  const now = NOW.getTime() + 7 * 60 * 60_000;
  const held = sourceStoredTotalHoldHeartbeat({ heldSince: NOW, now });
  expect(held).toEqual({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: "Stella/Backfill",
          Dimensions: [["Backfill"]],
          Metrics: [{ Name: "BackfillYielded", Unit: "Count" }],
        },
      ],
    },
    Backfill: "caseLaw.sourceStoredTotal",
    BackfillYielded: 1,
    heldSince: NOW.getTime(),
    heldTooLong: true,
    holdCause: "indicators_unavailable",
  });
  expect(
    sourceStoredTotalHoldHeartbeat({
      heldSince: NOW,
      now: NOW.getTime() + 60_000,
    }).heldTooLong,
  ).toBe(false);
  expect(sourceStoredTotalHoldHeartbeat({ heldSince: null, now })).toEqual({
    _aws: held._aws,
    Backfill: held.Backfill,
    BackfillYielded: 0,
    heldSince: null,
    heldTooLong: false,
    holdCause: "none",
  });
});
