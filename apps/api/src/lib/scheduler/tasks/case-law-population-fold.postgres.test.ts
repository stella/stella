import { panic, Result, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import {
  caseLawPopulationCounts,
  caseLawPopulationCountsLive,
  caseLawPopulationDeltas,
  caseLawSources,
  databaseBackfillStates,
  schedulerJobs,
  systemAuditRuns,
} from "@/api/db/schema";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import { createHttpApp } from "@/api/http/app";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readCaseLawPopulationFreshness } from "@/api/lib/case-law/population-count-freshness";
import {
  CASE_LAW_POPULATION_DELTA_BACKLOG_LIMIT,
  CASE_LAW_POPULATION_FOLD_BATCH_LIMIT,
  CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER,
} from "@/api/lib/case-law/population-count-limits";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import type { LegalBrowseFacets } from "@/api/lib/legal-search/types";
import { logger } from "@/api/lib/observability/logger";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";

import {
  createCaseLawPopulationFoldTask,
  FOLD_CASE_LAW_POPULATION_COUNTS_TASK,
} from "./case-law-population-fold";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PROPERTY_ID = "population live backlog window preserves exact snapshots";

class PopulationFoldFixtureRollback extends TaggedError(
  "PopulationFoldFixtureRollback",
)<{
  message: string;
}> {}

const drainPopulationDeltas = async (db: Pick<SchedulerDb, "execute">) => {
  for (let batch = 0; batch < 16; batch += 1) {
    const [row] = await db.execute(sql`
      SELECT done FROM public.fold_case_law_population_counts(${CASE_LAW_POPULATION_FOLD_BATCH_LIMIT})
    `);
    if (row?.["done"] === true) {
      return;
    }
  }
  panic(
    "Population fixture backlog did not drain within sixteen bounded batches",
  );
};

const withFoldFixture = async (work: (db: SchedulerDb) => Promise<void>) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ??
    panic("Population fold proof requires DATABASE_URL");
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const rollback = new PopulationFoldFixtureRollback({
      message: "Roll back population fold fixture",
    });
    expect(
      await rejectionOf(
        db.transaction(async (tx) => {
          const fixtureDb = asTestRaw<SchedulerDb>(tx);
          await tx.execute(
            sql`SELECT public.assert_case_law_population_ready()`,
          );
          await drainPopulationDeltas(fixtureDb);
          await tx
            .delete(databaseBackfillStates)
            .where(
              eq(
                databaseBackfillStates.name,
                SCHEDULER_BACKFILL_IDS.populationCounts,
              ),
            );
          await work(fixtureDb);
          abortTransaction(rollback);
        }),
      ),
    ).toBe(rollback);
  });
};

const readCaseLawPopulationBucketCount = async (
  db: Pick<SchedulerDb, "select">,
) => {
  const [summary] = await db
    .select({ buckets: sql<number>`count(*)::integer` })
    .from(caseLawPopulationCountsLive)
    .where(sql`public.assert_case_law_population_ready()`);
  if (!summary) {
    return panic("Population fixture aggregate returned no row");
  }
  return { buckets: summary.buckets };
};

const appendDeltas = async (
  db: SchedulerDb,
  sourceId: SafeId<"caseLawSource">,
  count: number,
) => {
  await db.execute(sql`INSERT INTO public.case_law_population_deltas (kind, country, source_id, value, delta)
    SELECT 'court', 'CZE', ${sourceId}, 'Fold fixture court', 1 FROM generate_series(1, ${count})`);
};

type RunFoldTaskOptions = {
  clock?: () => number;
  runId?: SafeId<"schedulerJobRun">;
  jobId?: string;
};

const runFoldTask = async (
  db: SchedulerDb,
  {
    clock,
    runId = createSafeId<"schedulerJobRun">(),
    jobId = `population-fold-${runId}`,
  }: RunFoldTaskOptions = {},
) => {
  const [job] = await db
    .insert(schedulerJobs)
    .values({
      id: jobId,
      description: "Population fold fixture",
      nextRunAt: new Date("2026-10-01T12:00:00Z"),
      schedule: { type: "interval", everyMs: 60_000 },
      task: FOLD_CASE_LAW_POPULATION_COUNTS_TASK,
    })
    .returning();
  if (!job) {
    return panic("Population fold scheduler fixture was not inserted");
  }
  const continuations: Date[] = [];
  const task = createCaseLawPopulationFoldTask({
    ...(clock === undefined ? {} : { clock }),
    createRuntime: (options) =>
      createScriptBackfillRuntime({
        ...options,
        readVerdict: async () => ({ kind: "normal", signals: [] }),
        slot: { tryAcquire: async () => true, release: () => {} },
      }),
  });
  expect(
    await task({
      db,
      job,
      dueAt: DueSlot.of(job),
      payload: null,
      runId,
      scheduleContinuation: (nextRunAt) => {
        continuations.push(nextRunAt);
      },
      signal: new AbortController().signal,
      logger,
    }),
  ).toBeUndefined();
  return { runId, jobId: job.id, continuations };
};

const probeMaintenance = async (db: SchedulerDb, name: string) => {
  let calls = 0;
  const runtime = createScriptBackfillRuntime({
    db,
    name,
    tableName: "case_law_decisions",
    initialSize: 1,
    readVerdict: async () => ({ kind: "normal", signals: [] }),
    slot: { tryAcquire: async () => true, release: () => {} },
  });
  try {
    const result = await Result.tryPromise({
      try: async () =>
        await runtime.step(async () => {
          calls += 1;
          return { cursor: null, done: true, value: "admitted" };
        }),
      catch: (cause: unknown) => cause,
    });
    return { result, calls };
  } finally {
    await runtime.close();
  }
};

describe.skipIf(!enabled)("population fold scheduler owner (postgres)", () => {
  test("the provider-independent scheduled owner folds multiple batches and audits every delta", async () => {
    const declaration = DECLARED_SCHEDULER_JOBS.find(
      ({ id }) => id === SCHEDULER_BACKFILL_IDS.populationCounts,
    );
    expect(declaration).toMatchObject({
      task: FOLD_CASE_LAW_POPULATION_COUNTS_TASK,
      reads: "load-governed",
      mode: "recurring",
      schedule: { type: "interval", everyMs: 60_000 },
    });
    expect(declaration && "enabled" in declaration).toBe(false);
    await withFoldFixture(async (db) => {
      const sourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `fold-${sourceId}`,
        name: "Fold fixture",
      });
      const count = CASE_LAW_POPULATION_FOLD_BATCH_LIMIT * 2 + 7;
      await appendDeltas(db, sourceId, count);
      expect(
        await db
          .select({ count: sql<number>`count(*)::integer` })
          .from(caseLawPopulationDeltas)
          .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
      ).toEqual([{ count }]);
      const { runId } = await runFoldTask(db);
      expect(
        await db
          .select()
          .from(caseLawPopulationDeltas)
          .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
      ).toEqual([]);
      const base = await db
        .select()
        .from(caseLawPopulationCounts)
        .where(eq(caseLawPopulationCounts.sourceId, sourceId));
      const live = await db
        .select()
        .from(caseLawPopulationCountsLive)
        .where(eq(caseLawPopulationCountsLive.sourceId, sourceId));
      expect(base).toEqual([
        {
          kind: "court",
          country: "CZE",
          sourceId,
          value: "Fold fixture court",
          total: count,
        },
      ]);
      expect(live).toEqual(base);
      const audits = await db
        .select({ counts: systemAuditRuns.counts })
        .from(systemAuditRuns)
        .where(
          and(
            eq(systemAuditRuns.actor, "system:case-law-population-fold"),
            eq(systemAuditRuns.subject, runId),
          ),
        );
      expect(audits.length).toBeGreaterThan(1);
      expect(
        audits.reduce(
          (total, { counts }) =>
            total +
            (counts["deltas"] ?? panic("Fold audit delta count missing")),
          0,
        ),
      ).toBe(count);
    });
  }, 30_000); // timeout: the production scheduler commits several bounded runtime units against real PostgreSQL.

  test("a fold preserves lower delta identities that commit after its selected batch", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Commit-order fold proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const { db: writer } = openClient({ max: 1 });
      const { db: observer } = openClient({ max: 1 });
      await drainPopulationDeltas(asTestRaw<SchedulerDb>(db));
      const sourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `commit-order-${sourceId}`,
        name: "Commit order fixture",
      });
      const lowerReady = Promise.withResolvers<number>();
      const releaseLower = Promise.withResolvers<undefined>();
      const pendingWriter = Result.tryPromise({
        try: async () =>
          await writer.transaction(async (tx) => {
            const [row] = await tx
              .insert(caseLawPopulationDeltas)
              .values({
                kind: "court",
                country: "CZE",
                sourceId,
                value: "Commit order court",
                delta: 1,
              })
              .returning({ id: caseLawPopulationDeltas.id });
            lowerReady.resolve(
              row?.id ?? panic("Lower delta fixture was not inserted"),
            );
            await releaseLower.promise;
          }),
        catch: (cause: unknown) => {
          lowerReady.reject(cause);
          return cause;
        },
      });
      try {
        const lowerId = await lowerReady.promise;
        const [higher] = await db
          .insert(caseLawPopulationDeltas)
          .values({
            kind: "court",
            country: "CZE",
            sourceId,
            value: "Commit order court",
            delta: 1,
          })
          .returning({ id: caseLawPopulationDeltas.id });
        expect(higher?.id).toBeGreaterThan(lowerId);
        const [first] = await observer.execute(
          sql`SELECT * FROM public.fold_case_law_population_counts(2048)`,
        );
        expect(first).toMatchObject({ folded: 1, done: true });
        expect(
          await observer
            .select({ total: caseLawPopulationCounts.total })
            .from(caseLawPopulationCounts)
            .where(eq(caseLawPopulationCounts.sourceId, sourceId)),
        ).toEqual([{ total: 1 }]);
        releaseLower.resolve(undefined);
        const writerResult = await pendingWriter;
        expect(writerResult.isOk()).toBe(true);
        expect(
          await observer
            .select({ id: caseLawPopulationDeltas.id })
            .from(caseLawPopulationDeltas)
            .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
        ).toEqual([{ id: lowerId }]);
        expect(
          await observer
            .select({ total: caseLawPopulationCountsLive.total })
            .from(caseLawPopulationCountsLive)
            .where(eq(caseLawPopulationCountsLive.sourceId, sourceId)),
        ).toEqual([{ total: 2 }]);
        const [second] = await observer.execute(
          sql`SELECT * FROM public.fold_case_law_population_counts(2048)`,
        );
        expect(second).toMatchObject({ folded: 1, done: true });
        expect(
          await observer
            .select({ total: caseLawPopulationCounts.total })
            .from(caseLawPopulationCounts)
            .where(eq(caseLawPopulationCounts.sourceId, sourceId)),
        ).toEqual([{ total: 2 }]);
        expect(
          await observer
            .select()
            .from(caseLawPopulationDeltas)
            .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
        ).toEqual([]);
      } finally {
        releaseLower.resolve(undefined);
        await pendingWriter;
        await db
          .delete(caseLawPopulationDeltas)
          .where(eq(caseLawPopulationDeltas.sourceId, sourceId));
        await db
          .delete(caseLawPopulationCounts)
          .where(eq(caseLawPopulationCounts.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  }, 30_000); // timeout: a writer remains uncommitted while a separate observer folds a higher committed identity.

  test.each([null, 0, CASE_LAW_POPULATION_FOLD_BATCH_LIMIT + 1])(
    "population SQL helpers reject an unbounded batch size (%s)",
    async (size) =>
      await withFoldFixture(async (db) => {
        for (const statement of [
          sql`SELECT * FROM public.fold_case_law_population_counts(${size})`,
          sql`SELECT * FROM public.seed_case_law_population_counts(${size})`,
        ]) {
          const result = await Result.tryPromise({
            try: async () =>
              await db.transaction(async (tx) => await tx.execute(statement)),
            catch: getPgErrorCode,
          });
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error).toBe("P0001");
          }
        }
      }),
  );

  test("a fold run preserves its deadline reserve and requests continuation without starting a batch", async () => {
    await withFoldFixture(async (db) => {
      const sourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `budget-${sourceId}`,
        name: "Fold budget fixture",
      });
      await appendDeltas(db, sourceId, 1);
      let clockReads = 0;
      const { continuations, runId } = await runFoldTask(db, {
        clock: () => {
          clockReads += 1;
          return clockReads === 1 ? 0 : 35_000;
        },
      });
      expect(continuations).toHaveLength(1);
      expect(
        await db
          .select({ count: sql<number>`count(*)::integer` })
          .from(caseLawPopulationDeltas)
          .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
      ).toEqual([{ count: 1 }]);
      expect(
        await db
          .select()
          .from(systemAuditRuns)
          .where(eq(systemAuditRuns.subject, runId)),
      ).toEqual([]);
    });
  });

  // timeout: one real 45-second governed run drains a three-window burst while public HTTP requests remain available.
  test("a three-window burst stays readable while one adaptive run drains it", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Population burst proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const fixtureDb = asTestRaw<SchedulerDb>(db);
      const sourceId = createSafeId<"caseLawSource">();
      const runId = createSafeId<"schedulerJobRun">();
      const jobId = `population-burst-${sourceId}`;
      const heldName = `population-held-${sourceId}`;
      const releasedName = `population-released-${sourceId}`;
      const count = CASE_LAW_POPULATION_DELTA_BACKLOG_LIMIT * 3;
      const baseline = 7;
      expect(count).toBe(49_152);
      expect(count).toBeGreaterThan(CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER);
      await drainPopulationDeltas(fixtureDb);
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `burst-${sourceId}`,
        name: "Burst fixture",
      });
      try {
        await db.insert(caseLawPopulationCounts).values([
          {
            kind: "country",
            country: "CZE",
            sourceId,
            value: "CZE",
            total: baseline,
          },
          {
            kind: "court",
            country: "CZE",
            sourceId,
            value: "Fold fixture court",
            total: baseline,
          },
        ]);
        const initial = await readCaseLawPopulationFreshness(
          asTestRaw<CaseLawPublicReadTransaction>(db),
        );
        await using server = serveForTest(
          createHttpApp({
            routes: publicCaseLawRoute,
            middleware: [errorBoundary],
          }),
        );
        const warmFacetsResponse = await server.fetch(
          new Request("http://localhost/case/decisions/facets?country=CZE", {
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(warmFacetsResponse.status).toBe(200);
        expect(await warmFacetsResponse.json()).toMatchObject({
          country: [{ value: "CZE", count: baseline }],
          countsFreshness: initial,
        });
        const warmStatusResponse = await server.fetch(
          new Request("http://localhost/case/decisions/status?country=CZE", {
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(warmStatusResponse.status).toBe(200);
        expect(await warmStatusResponse.json()).toMatchObject({
          decisions: baseline,
          countsFreshness: initial,
        });

        await db.execute(sql`INSERT INTO public.case_law_population_deltas (kind, country, source_id, value, delta)
          SELECT CASE WHEN n % 2 = 0 THEN 'country' ELSE 'court' END, 'CZE', ${sourceId},
            CASE WHEN n % 2 = 0 THEN 'CZE' ELSE 'Fold fixture court' END, 1
          FROM generate_series(1, ${count}) n`);
        expect(
          await db
            .select({ count: sql<number>`count(*)::integer` })
            .from(caseLawPopulationDeltas)
            .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
        ).toEqual([{ count }]);
        expect(
          await db
            .select({
              kind: caseLawPopulationCountsLive.kind,
              total: caseLawPopulationCountsLive.total,
            })
            .from(caseLawPopulationCountsLive)
            .where(eq(caseLawPopulationCountsLive.sourceId, sourceId))
            .orderBy(caseLawPopulationCountsLive.kind),
        ).toEqual([
          { kind: "country", total: baseline },
          { kind: "court", total: baseline },
        ]);
        const stale = await readCaseLawPopulationFreshness(
          asTestRaw<CaseLawPublicReadTransaction>(db),
        );
        expect(stale).toEqual({
          status: "stale",
          fold: initial.fold,
          foldedAt: initial.foldedAt,
        });
        const held = await probeMaintenance(fixtureDb, heldName);
        expect(held.calls).toBe(0);
        expect(held.result.isErr()).toBe(true);
        if (held.result.isErr()) {
          expect(held.result.error).toBeInstanceOf(BackfillHeldError);
        }
        const facetsResponse = await server.fetch(
          new Request("http://localhost/case/decisions/facets?country=CZE", {
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(facetsResponse.status).toBe(200);
        const facets = await readTestJson<LegalBrowseFacets>(facetsResponse);
        expect(facets).toMatchObject({
          country: [{ value: "CZE", count: baseline }],
          court: [{ value: "Fold fixture court", count: baseline }],
          countsFreshness: stale,
        });
        const statusResponse = await server.fetch(
          new Request("http://localhost/case/decisions/status?country=CZE", {
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(statusResponse.status).toBe(200);
        expect(await statusResponse.json()).toMatchObject({
          decisions: baseline,
          countsFreshness: stale,
        });
        const started = performance.now();
        const { continuations } = await runFoldTask(fixtureDb, {
          runId,
          jobId,
        });
        const elapsedMs = performance.now() - started;
        expect(elapsedMs).toBeLessThan(45_000);
        expect(
          await db
            .select({ count: sql<number>`count(*)::integer` })
            .from(caseLawPopulationDeltas)
            .where(eq(caseLawPopulationDeltas.sourceId, sourceId)),
        ).toEqual([{ count: 0 }]);
        expect(continuations).toEqual([]);
        const expected = baseline + count / 2;
        expect(
          await db
            .select({
              kind: caseLawPopulationCountsLive.kind,
              total: caseLawPopulationCountsLive.total,
            })
            .from(caseLawPopulationCountsLive)
            .where(eq(caseLawPopulationCountsLive.sourceId, sourceId))
            .orderBy(caseLawPopulationCountsLive.kind),
        ).toEqual([
          { kind: "country", total: expected },
          { kind: "court", total: expected },
        ]);
        const current = await readCaseLawPopulationFreshness(
          asTestRaw<CaseLawPublicReadTransaction>(db),
        );
        expect(current.status).toBe("current");
        expect(current.fold).toBeGreaterThan(stale.fold);
        expect(current.foldedAt).not.toBeNull();
        const admitted = await probeMaintenance(fixtureDb, releasedName);
        expect(admitted.calls).toBe(1);
        expect(admitted.result.isOk()).toBe(true);
        const audits = await db
          .select({ counts: systemAuditRuns.counts })
          .from(systemAuditRuns)
          .where(
            and(
              eq(systemAuditRuns.actor, "system:case-law-population-fold"),
              eq(systemAuditRuns.subject, runId),
            ),
          );
        expect(audits).toHaveLength(
          count / CASE_LAW_POPULATION_FOLD_BATCH_LIMIT,
        );
        expect(
          audits.every(
            ({ counts }) =>
              counts["deltas"] === CASE_LAW_POPULATION_FOLD_BATCH_LIMIT,
          ),
        ).toBe(true);
        expect(
          audits.reduce((sum, { counts }) => sum + Number(counts["deltas"]), 0),
        ).toBe(count);
        const currentFacetsResponse = await server.fetch(
          new Request("http://localhost/case/decisions/facets?country=CZE", {
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(currentFacetsResponse.status).toBe(200);
        expect(await currentFacetsResponse.json()).toMatchObject({
          country: [{ value: "CZE", count: expected }],
          court: [{ value: "Fold fixture court", count: expected }],
          countsFreshness: current,
        });
        const currentStatusResponse = await server.fetch(
          new Request("http://localhost/case/decisions/status?country=CZE", {
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(currentStatusResponse.status).toBe(200);
        expect(await currentStatusResponse.json()).toMatchObject({
          decisions: expected,
          countsFreshness: current,
        });
        console.info(
          JSON.stringify({
            event: "population_burst_proof",
            pendingBefore: count,
            pendingAfter: 0,
            elapsedMs,
            auditBatches: audits.length,
            auditDeltas: count,
            stale,
            current,
          }),
        );
      } finally {
        await db
          .delete(caseLawPopulationDeltas)
          .where(eq(caseLawPopulationDeltas.sourceId, sourceId));
        await db
          .delete(caseLawPopulationCounts)
          .where(eq(caseLawPopulationCounts.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
        await db
          .delete(systemAuditRuns)
          .where(eq(systemAuditRuns.subject, runId));
        await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
        await db
          .delete(databaseBackfillStates)
          .where(
            inArray(databaseBackfillStates.name, [
              heldName,
              releasedName,
              SCHEDULER_BACKFILL_IDS.populationCounts,
            ]),
          );
      }
    });
  }, 60_000);

  // timeout: shuffled boundaries seed the full window and verify current and folded snapshots against real PostgreSQL.
  test(
    PROPERTY_ID,
    async () => {
      await assertProperty(
        PROPERTY_ID,
        fc.asyncProperty(
          fc.shuffledSubarray([-1, 0, 1], { minLength: 3, maxLength: 3 }),
          async (offsets) =>
            await withFoldFixture(async (db) => {
              for (const offset of offsets) {
                const rollback = new PopulationFoldFixtureRollback({
                  message: "Roll back backlog boundary case",
                });
                // db-await-in-loop: each boundary is an isolated real-Postgres savepoint over the same canonical owner.
                expect(
                  await rejectionOf(
                    db.transaction(async (tx) => {
                      const caseDb = asTestRaw<SchedulerDb>(tx);
                      const sourceId = createSafeId<"caseLawSource">();
                      await tx.insert(caseLawSources).values({
                        id: sourceId,
                        adapterKey: `cap-${sourceId}`,
                        name: "Backlog window fixture",
                      });
                      const total = 13;
                      await tx.insert(caseLawPopulationCounts).values({
                        kind: "court",
                        country: "CZE",
                        sourceId,
                        value: "Fold fixture court",
                        total,
                      });
                      const baseline =
                        await readCaseLawPopulationBucketCount(caseDb);
                      const snapshot = await readCaseLawPopulationFreshness(
                        asTestRaw<CaseLawPublicReadTransaction>(tx),
                      );
                      const count =
                        CASE_LAW_POPULATION_DELTA_BACKLOG_LIMIT + offset;
                      await appendDeltas(caseDb, sourceId, count);
                      expect(
                        await readCaseLawPopulationBucketCount(caseDb),
                      ).toEqual(baseline);
                      expect(
                        await readCaseLawPopulationFreshness(
                          asTestRaw<CaseLawPublicReadTransaction>(tx),
                        ),
                      ).toEqual({
                        status: offset > 0 ? "stale" : "current",
                        fold: snapshot.fold,
                        foldedAt: snapshot.foldedAt,
                      });
                      expect(
                        await tx
                          .select({ total: caseLawPopulationCountsLive.total })
                          .from(caseLawPopulationCountsLive)
                          .where(
                            eq(caseLawPopulationCountsLive.sourceId, sourceId),
                          ),
                      ).toEqual([{ total: total + (offset > 0 ? 0 : count) }]);
                      abortTransaction(rollback);
                    }),
                  ),
                ).toBe(rollback);
              }
            }),
        ),
        { numRuns: 2 },
      );
    },
    120_000,
  );
});
