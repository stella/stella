import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { initialBatchState, nextBatch } from "@stll/db-load-gate/health";

import {
  BACKFILL_TABLE_CONTENTION,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import {
  caseLawCoverageSummaries,
  databaseBackfillStates,
  schedulerJobs,
} from "@/api/db/schema";
import { loadGateHealthConfig } from "@/api/env-online-index";
import { createSafeId } from "@/api/lib/branded-types";
import { CASE_LAW_COVERAGE_CURRENT_WITHIN_MS } from "@/api/lib/case-law/coverage-freshness";
import type { CaseLawCoveragePart } from "@/api/lib/case-law/coverage-parts";
import { CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS } from "@/api/lib/case-law/coverage-refresh-interval";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { logger } from "@/api/lib/observability/logger";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  caseLawCoverageRefreshConfig,
  createCaseLawCoverageRefreshTask,
  REFRESH_CASE_LAW_COVERAGE_TASK,
} from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: SchedulerDb;
const JOB_ID = "coverage-refresh-test";

// timeout: build the complete migration schema in embedded PostgreSQL once.
beforeAll(async () => {
  client = await createTestPglite();
  db = asTestRaw<SchedulerDb>(drizzle({ client }));
  await db.insert(schedulerJobs).values({
    id: JOB_ID,
    description: "Coverage refresh fixture",
    nextRunAt: new Date("2026-10-01T12:00:00Z"),
    schedule: { type: "interval", everyMs: 300_000 },
    task: REFRESH_CASE_LAW_COVERAGE_TASK,
  });
}, 120_000);
afterAll(async () => await client.close());

const refreshContext = async () => {
  const job =
    (await db.select().from(schedulerJobs)).find(({ id }) => id === JOB_ID) ??
    panic("Coverage scheduler fixture is missing");
  return {
    db,
    job,
    payload: null,
    dueAt: DueSlot.of(job),
    runId: createSafeId<"schedulerJobRun">(),
    scheduleContinuation: () => {},
    signal: new AbortController().signal,
    logger,
  };
};

const createRuntime: typeof createScriptBackfillRuntime = (options) =>
  createScriptBackfillRuntime({
    ...options,
    clock: () => Date.parse("2026-10-01T12:00:00Z"),
    readVerdict: async () => ({ kind: "normal", signals: [] }),
    // Embedded PostgreSQL owns one session; PostgreSQL tests cover the shared slot.
    slot: { tryAcquire: async () => true, release: () => {} },
  });

/** The fixture answer, computed at `generatedAt` with `unreadParts` unread. */
const answerAt = (
  generatedAt: string,
  unreadParts: readonly CaseLawCoveragePart[] = [],
) => ({
  ...CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
  generatedAt,
  unreadParts,
  countries: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE.countries.map((country) => ({
    ...country,
    unreadParts,
  })),
});

const refreshWith = async (
  computed: Awaited<
    ReturnType<
      Parameters<typeof createCaseLawCoverageRefreshTask>[0]["compute"]
    >
  >,
) => {
  // A failed run backs off; each run here starts from a clean slot state.
  await db
    .delete(databaseBackfillStates)
    .where(eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.coverage));
  return await createCaseLawCoverageRefreshTask({
    createRuntime,
    compute: async () => computed,
  })(await refreshContext());
};

const storedSummary = async () =>
  (await db.select().from(caseLawCoverageSummaries)).at(0);

test("coverage refresh stores partial answers, but never over a complete one that still reads as current", async () => {
  expect(
    await refreshWith({
      answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      complete: true,
    }),
  ).toBeUndefined();
  const published = await storedSummary();
  expect(published?.answer).toEqual(CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE);
  expect(published?.generatedAt.toISOString()).toBe(
    CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE.generatedAt,
  );
  expect(published?.sourcePolicy).toBe("[]");

  // Five minutes later the complete answer is still current: it stays.
  expect(
    await refreshWith({
      answer: answerAt("2026-10-01T12:05:00.000Z", ["facets"]),
      complete: false,
    }),
  ).toBeUndefined();
  expect(await storedSummary()).toEqual(published);

  // Past the window a partial answer is better than an old complete one.
  const lateAt = new Date(
    Date.parse(CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE.generatedAt) +
      CASE_LAW_COVERAGE_CURRENT_WITHIN_MS +
      60_000,
  ).toISOString();
  const late = answerAt(lateAt, ["facets"]);
  expect(await refreshWith({ answer: late, complete: false })).toBeUndefined();
  expect((await storedSummary())?.answer).toEqual(late);
  expect((await storedSummary())?.generatedAt.toISOString()).toBe(lateAt);

  // A partial answer always replaces a partial one, even a minute later.
  const nextAt = new Date(Date.parse(lateAt) + 60_000).toISOString();
  const next = answerAt(nextAt, ["courts"]);
  expect(await refreshWith({ answer: next, complete: false })).toBeUndefined();
  expect((await storedSummary())?.answer).toEqual(next);

  // A complete answer always replaces whatever is stored.
  const completeAt = new Date(Date.parse(nextAt) + 60_000).toISOString();
  const complete = answerAt(completeAt);
  expect(
    await refreshWith({ answer: complete, complete: true }),
  ).toBeUndefined();
  expect((await storedSummary())?.answer).toEqual(complete);

  // Without the catalogue there is no answer to store at all.
  expect(
    (
      await refreshWith({
        answer: { message: "Coverage is unavailable" },
        complete: false,
      })
    )?.isErr(),
  ).toBe(true);
  expect((await storedSummary())?.answer).toEqual(complete);
});

test("a failed coverage read rolls back only itself, and the refresh stores the rest", async () => {
  for (const [index, transport] of (
    ["rejected", "result"] as const
  ).entries()) {
    await db
      .delete(databaseBackfillStates)
      .where(eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.coverage));
    const generatedAt = new Date(
      Date.parse("2026-10-02T12:00:00.000Z") + index * 60_000,
    ).toISOString();
    let rejectedRead: unknown;
    let subsequentReads = 0;
    const failed = createCaseLawCoverageRefreshTask({
      createRuntime,
      compute: async (readDb) => {
        const read = await Result.tryPromise({
          try: async () =>
            await readDb(async (tx) => {
              const cancel = async () =>
                await tx.execute(sql`DO $$ BEGIN
                  RAISE EXCEPTION USING ERRCODE = '57014', MESSAGE = 'coverage fixture statement canceled';
                END $$`);
              if (transport === "result") {
                return await Result.tryPromise({
                  try: cancel,
                  catch: (cause) =>
                    new SchedulerTaskFailure({
                      message: "Coverage fixture read failed",
                      cause,
                    }),
                });
              }
              return await cancel();
            }),
          catch: (cause) => cause,
        });
        if (read.isErr()) {
          rejectedRead = read.error;
        }
        // The transaction is still usable for the parts after the failed one.
        await readDb(async (tx) => {
          subsequentReads += 1;
          return await tx.execute(sql`SELECT 1`);
        });
        return { answer: answerAt(generatedAt, ["facets"]), complete: false };
      },
    });
    expect(await failed(await refreshContext())).toBeUndefined();
    const evidence = readEvidence(rejectedRead);
    expect(evidence.nodes.some(({ sqlState }) => sqlState === "57014")).toBe(
      true,
    );
    expect(evidence.nodes.some(({ sqlState }) => sqlState === "25P02")).toBe(
      false,
    );
    expect(
      gradeFailure(
        evidence,
        failureSink({ event: "coverage.fixture", expected: [] }),
      ).reason,
    ).toBe("pg_query_canceled");
    expect(subsequentReads).toBe(1);
    expect((await storedSummary())?.generatedAt.toISOString()).toBe(
      generatedAt,
    );
  }
});

test("reads left when the refresh budget is spent go unread, and what was read is stored", async () => {
  await db
    .delete(databaseBackfillStates)
    .where(eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.coverage));
  const generatedAt = "2026-10-03T12:00:00.000Z";
  let started = 0;
  let refused: unknown;
  const spent = createCaseLawCoverageRefreshTask({
    createRuntime,
    readBudget: () => AbortSignal.abort(),
    compute: async (readDb) => {
      const read = await Result.tryPromise({
        try: async () =>
          await readDb(async (tx) => {
            started += 1;
            return await tx.execute(sql`SELECT 1`);
          }),
        catch: (cause) => cause,
      });
      if (read.isErr()) {
        refused = read.error;
      }
      return { answer: answerAt(generatedAt, ["courts"]), complete: false };
    },
  });
  expect(await spent(await refreshContext())).toBeUndefined();
  expect(started).toBe(0);
  expect(refused).toBeInstanceOf(Error);
  expect((await storedSummary())?.answer).toEqual(
    answerAt(generatedAt, ["courts"]),
  );
});

test("a held coverage refresh computes nothing and keeps the stored answer", async () => {
  const context = await refreshContext();
  const published = await storedSummary();
  let computations = 0;
  const held = createCaseLawCoverageRefreshTask({
    createRuntime: (options) =>
      createScriptBackfillRuntime({
        ...options,
        clock: () => Date.parse("2026-10-01T12:00:00Z"),
        readVerdict: async () => ({ kind: "stop", signals: [] }),
        slot: { tryAcquire: async () => true, release: () => {} },
      }),
    compute: async () => {
      computations += 1;
      return { answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE, complete: true };
    },
  });
  expect(await held(context)).toBeUndefined();
  expect(computations).toBe(0);
  expect(await storedSummary()).toEqual(published);
});

// The refresh reads the corpus under shared locks and writes only its own
// summary row; it is governed as that, not as a corpus writer.
test("coverage refresh is governed as a shared reader at the configured floors, held at most one interval, and still needs the backfill slot", async () => {
  const job =
    (await db.select().from(schedulerJobs)).find(({ id }) => id === JOB_ID) ??
    panic("Coverage scheduler fixture is missing");
  const context = {
    db,
    job,
    payload: null,
    dueAt: DueSlot.of(job),
    runId: createSafeId<"schedulerJobRun">(),
    scheduleContinuation: () => {},
    signal: new AbortController().signal,
    logger,
  };
  const resetCheckpoint = async () =>
    await db
      .delete(databaseBackfillStates)
      .where(eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.coverage));
  const readCheckpoint = async () =>
    (
      await db
        .select({ batch: databaseBackfillStates.batch })
        .from(databaseBackfillStates)
        .where(eq(databaseBackfillStates.name, SCHEDULER_BACKFILL_IDS.coverage))
    ).at(0)?.batch ?? panic("Coverage checkpoint is missing");
  let computations = 0;
  const compute = async () => {
    computations += 1;
    return await Promise.resolve({
      answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      complete: true,
    });
  };

  // Long lock holders and autovacuum on the corpus do not describe a shared
  // reader; the IO balance and busy windows still hold it, at the configured floors.
  const declared: Parameters<typeof createScriptBackfillRuntime>[0][] = [];
  await resetCheckpoint();
  expect(
    await createCaseLawCoverageRefreshTask({
      createRuntime: (options) => {
        declared.push(options);
        return createScriptBackfillRuntime({
          ...options,
          readVerdict: async () => ({ kind: "stop", signals: [] }),
          slot: { tryAcquire: async () => true, release: () => {} },
        });
      },
      compute,
    })(context),
  ).toBeUndefined();
  expect(declared).toHaveLength(1);
  expect(declared.at(0)?.tableContention).toBe(
    BACKFILL_TABLE_CONTENTION.SHARED_READ,
  );
  const coverageConfig = caseLawCoverageRefreshConfig();
  expect(declared.at(0)?.config).toEqual(coverageConfig);
  const environment = loadGateHealthConfig();
  expect({
    hardFloor: coverageConfig.hardFloor,
    startFloor: coverageConfig.startFloor,
    resumeFloor: "resumeFloor" in coverageConfig,
    busyWindows: coverageConfig.busyWindows,
  }).toEqual({
    hardFloor: environment.hardFloor,
    startFloor: environment.startFloor,
    resumeFloor: false,
    busyWindows: environment.busyWindows,
  });
  // The script runtime's own advisory slot is the one every backfill shares.
  expect(declared.at(0)).not.toHaveProperty("slot");

  // However many holds in a row, the next one never outlasts the interval.
  for (let holdCount = 0; holdCount <= 60; holdCount += 1) {
    const decision = nextBatch({
      state: {
        ...initialBatchState(caseLawCoverageRefreshConfig()),
        holdCount,
      },
      verdict: { kind: "stop", signals: [] },
      lastDurationMs: null,
      config: caseLawCoverageRefreshConfig(),
      clock: () => 0,
    });
    expect(decision.action).toBe("hold");
    expect(decision.holdUntil ?? Infinity).toBeLessThanOrEqual(
      CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS,
    );
  }
  // And the persisted hold of consecutive held runs stays within it too.
  await resetCheckpoint();
  let now = Date.parse("2026-10-01T12:00:00Z");
  const stopped = createCaseLawCoverageRefreshTask({
    createRuntime: (options) =>
      createScriptBackfillRuntime({
        ...options,
        clock: () => now,
        readVerdict: async () => ({ kind: "stop", signals: [] }),
        slot: { tryAcquire: async () => true, release: () => {} },
      }),
    compute,
  });
  for (let run = 0; run < 12; run += 1) {
    // db-await-in-loop: each held run reads the hold the previous one persisted.
    expect(await stopped(context)).toBeUndefined();
    const batch = await readCheckpoint();
    expect(batch.holdCount).toBe(run + 1);
    const holdUntil = batch.holdUntil ?? panic("Held run persisted no hold");
    expect(holdUntil - now).toBeGreaterThan(0);
    expect(holdUntil - now).toBeLessThanOrEqual(
      CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS,
    );
    now = holdUntil;
  }

  // A real backfill holding the shared slot still holds the refresh.
  await resetCheckpoint();
  expect(
    await createCaseLawCoverageRefreshTask({
      createRuntime: (options) =>
        createScriptBackfillRuntime({
          ...options,
          clock: () => Date.parse("2026-10-01T12:00:00Z"),
          readVerdict: async () => ({ kind: "normal", signals: [] }),
          slot: { tryAcquire: async () => false, release: () => {} },
        }),
      compute,
    })(context),
  ).toBeUndefined();
  expect((await readCheckpoint()).holdUntil).not.toBeNull();
  expect(computations).toBe(0);
});
