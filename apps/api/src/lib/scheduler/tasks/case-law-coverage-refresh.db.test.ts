import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { caseLawCoverageSummaries, schedulerJobs } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  createCaseLawCoverageRefreshTask,
  REFRESH_CASE_LAW_COVERAGE_TASK,
} from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { CASE_LAW_COVERAGE_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";
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

test("coverage refresh publishes complete answers atomically and retains them on degraded reads", async () => {
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
  const createRuntime: typeof createScriptBackfillRuntime = (options) =>
    createScriptBackfillRuntime({
      ...options,
      clock: () => Date.parse("2026-10-01T12:00:00Z"),
      readVerdict: async () => ({ kind: "normal", signals: [] }),
      // Embedded PostgreSQL owns one session; PostgreSQL tests cover the shared slot.
      slot: { tryAcquire: async () => true, release: () => {} },
    });
  const complete = createCaseLawCoverageRefreshTask({
    createRuntime,
    compute: async () => ({
      answer: CASE_LAW_COVERAGE_FIXTURE,
      complete: true,
    }),
  });
  expect(await complete(context)).toBeUndefined();
  const published = (await db.select().from(caseLawCoverageSummaries)).at(0);
  expect(published?.answer).toEqual(CASE_LAW_COVERAGE_FIXTURE);
  expect(published?.generatedAt.toISOString()).toBe(
    CASE_LAW_COVERAGE_FIXTURE.generatedAt,
  );
  expect(published?.sourcePolicy).toBe("[]");
  const degraded = createCaseLawCoverageRefreshTask({
    createRuntime,
    compute: async () => ({
      answer: {
        ...CASE_LAW_COVERAGE_FIXTURE,
        generatedAt: "2026-10-01T12:05:00.000Z",
      },
      complete: false,
    }),
  });
  expect((await degraded(context))?.isErr()).toBe(true);
  expect((await db.select().from(caseLawCoverageSummaries)).at(0)).toEqual(
    published,
  );
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
      return { answer: CASE_LAW_COVERAGE_FIXTURE, complete: true };
    },
  });
  expect(await held(context)).toBeUndefined();
  expect(computations).toBe(0);
  expect((await db.select().from(caseLawCoverageSummaries)).at(0)).toEqual(
    published,
  );
});
