import { panic } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, isNotNull, sql } from "drizzle-orm";
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
  emitSourceStoredTotalHoldHeartbeats,
  sourceStoredTotalHoldHeartbeat,
} from "./source-total-hold";
import {
  createSourceStoredTotalMaintenanceRuntime,
  recordSourceStoredTotalHold,
  refreshNextSourceStoredTotal,
  refreshSourceStoredTotal,
} from "./source-totals";

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

test("an ordinary gate hold persists the yielded gauge and UNKNOWN warns once in that same slot", async () => {
  const sourceId = await seed();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const holdAt = new Date(NOW.getTime() + 1000);
  try {
    expect(
      await refreshSourceStoredTotal({
        scopedDb,
        sourceId,
        readDatabaseNow: async () => holdAt,
        acquireAdmission: async () => "held",
        countSource: async () => panic("Held admission must not count"),
      }),
    ).toBe("held");
    const held = await read(sourceId);
    expect(held).toEqual({
      heldSince: holdAt,
      warnedSlot: null,
      due: NOW,
      attemptedAt: null,
      total: null,
      asOf: null,
    });
    expect(
      sourceStoredTotalHoldHeartbeat({
        heldSince: held.heldSince,
        now: holdAt.getTime(),
      }).BackfillYielded,
    ).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(await unknownRefresh(sourceId, new Date(NOW.getTime() + 2000))).toBe(
      "held",
    );
    expect(await unknownRefresh(sourceId, new Date(NOW.getTime() + 3000))).toBe(
      "held",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await read(sourceId)).heldSince).toEqual(holdAt);
    expect((await read(sourceId)).warnedSlot).toEqual(NOW);
    await recordSourceStoredTotalHold({
      scopedDb,
      sourceId,
      now: new Date(NOW.getTime() + 4000),
      slot: NOW,
      admission: "held",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await read(sourceId)).heldSince).toEqual(holdAt);
  } finally {
    warn.mockRestore();
  }
});

test("a source that is no longer due cannot acquire a durable gate hold", async () => {
  const sourceId = await seed();
  const futureSlot = new Date(NOW.getTime() + 60_000);
  await db
    .update(caseLawSources)
    .set({ storedTotalNextRefreshAt: futureSlot })
    .where(eq(caseLawSources.id, sourceId));
  for (const admission of ["held", "unknown"] as const) {
    await recordSourceStoredTotalHold({
      scopedDb,
      sourceId,
      now: NOW,
      slot: futureSlot,
      admission,
    });
    expect((await read(sourceId)).heldSince).toBeNull();
    expect((await read(sourceId)).warnedSlot).toBeNull();
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
    await recordSourceStoredTotalHold({
      scopedDb,
      sourceId,
      now: new Date(grantedAt.getTime() + 1000),
      slot: NOW,
      admission: "unknown",
    });
    expect(await read(sourceId)).toEqual(granted);
    await recordSourceStoredTotalHold({
      scopedDb,
      sourceId,
      now: new Date(grantedAt.getTime() + 1000),
      slot: NOW,
      admission: "held",
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
    holdCause: "admission_held",
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

test("a selection permission failure warns and leaves the ingestion cycle's outcome recoverable", async () => {
  const denied = Object.assign(new Error("selection permission denied"), {
    code: "42501",
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let admissions = 0;
  let counts = 0;
  try {
    expect(
      await refreshNextSourceStoredTotal({
        scopedDb: async () => {
          throw denied;
        },
        acquireAdmission: async () => {
          admissions += 1;
          return "granted";
        },
        countSource: async () => {
          counts += 1;
          return 5;
        },
      }),
    ).toBe("unavailable");
    expect(admissions).toBe(0);
    expect(counts).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "case_law.source_stored_total.selection_unavailable",
      expect.objectContaining({ "error.cause.pg_code": "42501" }),
    );
  } finally {
    warn.mockRestore();
  }
});

test("the emitted fixed-dimension gauge includes only due held sources on the database clock", async () => {
  // This emission scenario owns its hold census; older fixture rows cannot contribute.
  await db
    .update(caseLawSources)
    .set({ storedTotalHeldSince: null })
    .where(isNotNull(caseLawSources.storedTotalHeldSince));
  const clock = await db.execute(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS epoch_ms`,
  );
  const epoch = clock.rows.at(0)?.["epoch_ms"];
  if (typeof epoch !== "number") {
    return panic("Missing database clock in hold fixture");
  }
  const due = await seed();
  const future = await seed();
  const dueHeldSince = new Date(epoch - 2 * 60 * 60_000);
  const futureSlot = new Date(epoch + 24 * 60 * 60_000);
  await db
    .update(caseLawSources)
    .set({
      storedTotalNextRefreshAt: new Date(epoch - 60_000),
      storedTotalHeldSince: dueHeldSince,
    })
    .where(eq(caseLawSources.id, due));
  await db
    .update(caseLawSources)
    .set({
      storedTotalNextRefreshAt: futureSlot,
      storedTotalHeldSince: new Date(epoch - 7 * 60 * 60_000),
    })
    .where(eq(caseLawSources.id, future));
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await emitSourceStoredTotalHoldHeartbeats(scopedDb);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.at(0)))).toMatchObject({
      Backfill: "caseLaw.sourceStoredTotal",
      BackfillYielded: 1,
      heldSince: dueHeldSince.getTime(),
      heldTooLong: false,
      holdCause: "admission_held",
      _aws: { CloudWatchMetrics: [{ Dimensions: [["Backfill"]] }] },
    });
    await db
      .update(caseLawSources)
      .set({ storedTotalNextRefreshAt: futureSlot })
      .where(eq(caseLawSources.id, due));
    await emitSourceStoredTotalHoldHeartbeats(scopedDb);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.at(0)))).toMatchObject({
      Backfill: "caseLaw.sourceStoredTotal",
      BackfillYielded: 0,
      heldSince: null,
      heldTooLong: false,
      holdCause: "none",
    });
    expect((await read(due)).heldSince).toEqual(dueHeldSince);
  } finally {
    stdout.mockRestore();
  }
});

test("the maintenance runtime shares its database with heartbeat and observes database lifecycle failures", async () => {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const runtime = createSourceStoredTotalMaintenanceRuntime(scopedDb);
    expect(await runtime.acquireAdmission({ deadline: undefined })).toBe(
      "held",
    );
    await runtime.emitHoldHeartbeat();
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.at(0)))).toMatchObject({
      Backfill: "caseLaw.sourceStoredTotal",
    });
    const failure = Object.assign(new Error("database connection closed"), {
      errno: "57P01",
    });
    runtime.observeHeartbeatFailure(failure);
    expect(warn.mock.calls.at(-1)).toMatchObject([
      "case_law.source_stored_total.heartbeat_failed",
      {
        "failure.grade": "transient",
        "failure.reason": "pg_connection_lifecycle",
      },
    ]);
  } finally {
    stdout.mockRestore();
    warn.mockRestore();
  }
});
