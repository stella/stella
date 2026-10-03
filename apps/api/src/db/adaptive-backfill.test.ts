import { expect, test } from "bun:test";

import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";
import type { Verdict } from "@stll/db-load-gate/health";

import type { BackfillCheckpoint } from "./adaptive-backfill";
import { runAdaptiveBackfillBatch } from "./adaptive-backfill";

test("a resumed batch commits runnable state even when its accepted reading ages during work", async () => {
  const config = {
    ...defaultConfig,
    hardFloor: 65,
    resumeFloor: 75,
    startFloor: 80,
    minSize: 1,
    maxSize: 1000,
    busyWindows: [],
  };
  let now = Date.parse("2026-10-02T12:00:00Z");
  const initialNow = now;
  const verdict: Verdict = {
    kind: "degraded",
    signals: [
      {
        indicator: "ebs_balance",
        kind: "degraded",
        value: 75,
        threshold: 80,
        observedAt: new Date(now).toISOString(),
        reason: "accepted resume reading",
      },
    ],
  };
  const initial = {
    cursor: "old",
    batch: {
      ...initialBatchState(config),
      size: 1000,
      sleepMs: 1000,
      heldSince: now - 60_000,
      holdUntil: now - 1,
      holdCause: "load" as const,
      holdCount: 2,
    },
  };
  let checkpoint: BackfillCheckpoint<string> = initial;
  const result = await runAdaptiveBackfillBatch({
    config,
    clock: () => now,
    log: () => {},
    runInTransaction: async (work) => await work({}),
    readCheckpoint: async () => checkpoint,
    persistCheckpoint: async (_tx, next) => {
      checkpoint = next;
    },
    readVerdict: async () => verdict,
    slot: { tryAcquire: async () => true, release: () => {} },
    selectPage: async (_tx, cursor, size) => {
      expect(cursor).toBe("old");
      expect(size).toBe(500);
      now += config.maxStalenessMs + 1;
      return { items: ["row"], cursor: "next", done: false };
    },
    needsWork: () => true,
    persistItems: async (_tx, items) => {
      expect(items).toEqual(["row"]);
    },
  });
  expect(checkpoint).toEqual(result.checkpoint);
  expect(now - initialNow).toBeGreaterThan(config.maxStalenessMs);
  expect(result.checkpoint).toMatchObject({
    cursor: "next",
    batch: {
      heldSince: null,
      holdUntil: null,
      holdCause: null,
      holdCount: 0,
      size: 500,
      sleepMs: 2000,
    },
  });
});

test("a lost slot race resumes below the load resume floor after priority intent clears", async () => {
  const config = {
    ...defaultConfig,
    hardFloor: 65,
    resumeFloor: 75,
    startFloor: 80,
    busyWindows: [],
  };
  let now = Date.parse("2026-10-02T12:00:00Z");
  let acquired = false;
  let checkpoint: BackfillCheckpoint<string | null> = {
    cursor: null,
    batch: initialBatchState(config),
  };
  let batches = 0;
  const run = async () =>
    await runAdaptiveBackfillBatch({
      config,
      clock: () => now,
      log: () => {},
      runInTransaction: async (work) => await work({}),
      readCheckpoint: async () => checkpoint,
      persistCheckpoint: async (_tx, next) => {
        checkpoint = next;
      },
      readVerdict: async () => ({
        kind: "degraded",
        signals: [
          {
            indicator: "ebs_balance",
            kind: "degraded",
            value: 70,
            threshold: 80,
            observedAt: new Date(now).toISOString(),
            reason: "steady load",
          },
        ],
      }),
      slot: { tryAcquire: async () => acquired, release: () => {} },
      selectPage: async () => {
        batches += 1;
        return { items: [], cursor: "next", done: false };
      },
      needsWork: () => false,
      persistItems: () => {},
    });
  expect((await run()).status).toBe("held");
  expect(checkpoint.batch.holdCause).toBe("other");
  expect(batches).toBe(0);
  now += config.holdBackoffMs;
  acquired = true;
  expect((await run()).status).toBe("advanced");
  expect(batches).toBe(1);
  expect(checkpoint.batch).toMatchObject({
    heldSince: null,
    holdUntil: null,
    holdCause: null,
    holdCount: 0,
  });
});

for (const reading of ["fresh", "aged"] as const) {
  test(`a timed-out resumed batch preserves its original error when its following decision is ${reading}`, async () => {
    const config = {
      ...defaultConfig,
      hardFloor: 65,
      resumeFloor: 75,
      startFloor: 80,
      busyWindows: [],
    };
    let now = Date.parse("2026-10-02T12:00:00Z");
    const observedAt = new Date(now).toISOString();
    const databaseError = Object.assign(new Error("statement timeout"), {
      code: "57014",
    });
    let checkpoint: BackfillCheckpoint<string> = {
      cursor: "saved",
      batch: {
        ...initialBatchState(config),
        heldSince: now - 60_000,
        holdUntil: now - 1,
        holdCause: "load",
        holdCount: 1,
      },
    };
    let workCalls = 0;
    let persisted = 0;
    const result = await runAdaptiveBackfillBatch({
      config,
      clock: () => now,
      log: () => {},
      runInTransaction: async (work) => await work({}),
      readCheckpoint: async () => checkpoint,
      persistCheckpoint: async (_tx, next) => {
        checkpoint = next;
        persisted += 1;
      },
      readVerdict: async () => ({
        kind: "normal",
        signals: [
          {
            indicator: "ebs_balance",
            kind: "normal",
            value: 90,
            threshold: 80,
            observedAt,
            reason: "fresh resume reading",
          },
        ],
      }),
      slot: { tryAcquire: async () => true, release: () => {} },
      selectPage: async () => {
        workCalls += 1;
        if (reading === "aged") {
          now += config.maxStalenessMs + 1;
        }
        throw databaseError;
      },
      needsWork: () => false,
      persistItems: () => {},
      isStatementTimeout: (cause) => cause === databaseError,
    });
    expect(workCalls).toBe(1);
    expect(persisted).toBe(1);
    expect(result.status).toBe("retry");
    if (result.status !== "retry") {
      throw databaseError;
    }
    expect(result.error).toBe(databaseError);
    expect(result.error).toMatchObject({ code: "57014" });
    expect(result.checkpoint.cursor).toBe("saved");
    if (reading === "aged") {
      expect(result.checkpoint.batch.holdUntil).toBeGreaterThan(now);
      expect(result.checkpoint.batch.heldSince).not.toBeNull();
    } else {
      expect(result.checkpoint.batch.holdUntil).toBeNull();
      expect(result.checkpoint.batch.heldSince).toBeNull();
    }
  });
}
