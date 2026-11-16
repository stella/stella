import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import {
  caseLawDecisions,
  caseLawPopulationProjections,
  caseLawPopulationSeedState,
  caseLawSources,
  databaseBackfillStates,
  schedulerJobs,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { isCaseLawPopulationBuilding } from "@/api/lib/case-law/population-count-freshness";
import { CASE_LAW_POPULATION_SEED_REPAIR_NAME } from "@/api/lib/case-law/population-count-limits";
import { readPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facets";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import {
  createCaseLawPopulationSeedTask,
  SEED_CASE_LAW_POPULATION_COUNTS_TASK,
} from "./case-law-population-seed";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;
const JOB_ID = "population-seed-test";
const DECISIONS = 5;

let client: PGlite;
let db: SchedulerDb;
const sourceId = createSafeId<"caseLawSource">();

const readFacets = async () =>
  await withPublicLawReaderRole(drizzle({ client }), async (roleTx) => {
    // SAFETY: the role transaction supplies the select surface the read uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
    const tx = roleTx as unknown as CaseLawPublicReadTransaction;
    return await readPgFtsBrowseFacets(tx, {
      jurisdiction: "CZE",
      excludedSourceIds: [],
      limit: 10,
    });
  });

const readSeedPhase = async () => {
  const [state] = await db
    .select({ phase: caseLawPopulationSeedState.phase })
    .from(caseLawPopulationSeedState)
    .where(eq(caseLawPopulationSeedState.slot, 0));
  return state?.phase ?? panic("Population seed state is missing");
};

// timeout: build the complete migration schema in embedded PostgreSQL once.
beforeAll(async () => {
  client = await createTestPglite();
  db = asTestRaw<SchedulerDb>(drizzle({ client }));
  await db.insert(schedulerJobs).values({
    id: JOB_ID,
    description: "Population seed fixture",
    nextRunAt: new Date("2026-10-01T12:00:00Z"),
    schedule: { type: "interval", everyMs: 60_000 },
    task: SEED_CASE_LAW_POPULATION_COUNTS_TASK,
  });
  await db
    .insert(caseLawSources)
    .values(caseLawSourceRow({ id: sourceId, adapterKey: "seed-fixture" }));
  await db.insert(caseLawDecisions).values(
    Array.from({ length: DECISIONS }, (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      country: "CZE",
      language: "cs",
      court: "Seed fixture court",
      caseNumber: `seed/${String(index)}`,
      decisionDate: "2020-01-01",
      fulltext: "Seed fixture text",
    })),
  );
  // A release whose seed has not run: no projection, the walk at its start,
  // and a durable checkpoint, so startup admits it pending.
  await db
    .delete(caseLawPopulationProjections)
    .where(eq(caseLawPopulationProjections.sourceId, sourceId));
  await db.execute(sql`SELECT public.fold_case_law_population_counts(2048)`);
  await db
    .update(caseLawPopulationSeedState)
    .set({ phase: "scan", cursor: null, sourceId: null })
    .where(eq(caseLawPopulationSeedState.slot, 0));
  await db.insert(databaseBackfillStates).values({
    name: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
    cursor: null,
    batch: {
      size: 128,
      sleepMs: 0,
      stableBatches: 0,
      holdCount: 0,
      smoothedDurationMs: null,
      heldSince: null,
      holdCause: null,
      holdUntil: null,
    },
  });
}, DB_TEST_TIMEOUT_MS);
afterAll(async () => await client.close());

const runSeedTask = async () => {
  const job =
    (await db.select().from(schedulerJobs)).find(({ id }) => id === JOB_ID) ??
    panic("Population seed scheduler fixture is missing");
  const continuations: Date[] = [];
  const task = createCaseLawPopulationSeedTask({
    createRuntime: (options) =>
      createScriptBackfillRuntime({
        ...options,
        readVerdict: async () => ({ kind: "normal", signals: [] }),
        // Embedded PostgreSQL owns one session; PostgreSQL tests cover the shared slot.
        slot: { tryAcquire: async () => true, release: () => {} },
      }),
  });
  const outcome = await task({
    db,
    job,
    dueAt: DueSlot.of(job),
    payload: null,
    runId: createSafeId<"schedulerJobRun">(),
    scheduleContinuation: (nextRunAt) => {
      continuations.push(nextRunAt);
    },
    signal: new AbortController().signal,
    logger,
  });
  return { outcome, continuations };
};

// timeout: the scheduled run paces governed seed batches against embedded PostgreSQL.
test(
  "a pending seed reads as building, and the scheduled owner completes it",
  async () => {
    expect(await readSeedPhase()).toBe("scan");
    const building = await rejectionOf(readFacets());
    expect(isCaseLawPopulationBuilding(building)).toBe(true);

    const { outcome, continuations } = await runSeedTask();
    expect(outcome === undefined || outcome.isOk()).toBe(true);
    expect(continuations).toEqual([]);

    expect(await readSeedPhase()).toBe("complete");
    expect(
      await db
        .select({ decisionId: caseLawPopulationProjections.decisionId })
        .from(caseLawPopulationProjections)
        .where(eq(caseLawPopulationProjections.sourceId, sourceId)),
    ).toHaveLength(DECISIONS);
    const facets = await readFacets();
    expect(facets.country).toEqual([
      expect.objectContaining({ value: "CZE", count: DECISIONS }),
    ]);
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: embedded PostgreSQL serves the scheduler fixture slowly.
test(
  "a completed seed leaves the run nothing to schedule",
  async () => {
    const { outcome, continuations } = await runSeedTask();
    expect(outcome === undefined || outcome.isOk()).toBe(true);
    expect(continuations).toEqual([]);
  },
  DB_TEST_TIMEOUT_MS,
);

test("a failed read that is not the seed reads as a failure", () => {
  expect(isCaseLawPopulationBuilding(new TypeError("unrelated"))).toBe(false);
});
