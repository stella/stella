import { panic, Result, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import {
  caseLawPopulationCounts,
  caseLawPopulationCountsLive,
  caseLawPopulationDeltas,
  caseLawSources,
  databaseBackfillStates,
  schedulerJobs,
  systemAuditRuns,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_POPULATION_DELTA_BACKLOG_LIMIT,
  CASE_LAW_POPULATION_FOLD_BATCH_LIMIT,
} from "@/api/lib/case-law/population-count-limits";
import { readCaseLawPopulationBucketCount } from "@/api/lib/case-law/population-counts";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { logger } from "@/api/lib/observability/logger";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createCaseLawPopulationFoldTask,
  FOLD_CASE_LAW_POPULATION_COUNTS_TASK,
} from "./case-law-population-fold";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PROPERTY_ID =
  "population live backlog guard matches the configured limit";

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

const appendDeltas = async (
  db: SchedulerDb,
  sourceId: SafeId<"caseLawSource">,
  count: number,
) => {
  await db.execute(sql`INSERT INTO public.case_law_population_deltas (kind, country, source_id, value, delta)
    SELECT 'court', 'CZE', ${sourceId}, 'Fold fixture court', 1 FROM generate_series(1, ${count})`);
};

const runFoldTask = async (db: SchedulerDb) => {
  const [job] = await db
    .insert(schedulerJobs)
    .values({
      id: `population-fold-${createSafeId<"schedulerJobRun">()}`,
      description: "Population fold fixture",
      nextRunAt: new Date("2026-10-01T12:00:00Z"),
      schedule: { type: "interval", everyMs: 60_000 },
      task: FOLD_CASE_LAW_POPULATION_COUNTS_TASK,
    })
    .returning();
  if (!job) {
    return panic("Population fold scheduler fixture was not inserted");
  }
  const runId = createSafeId<"schedulerJobRun">();
  const task = createCaseLawPopulationFoldTask({
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
      scheduleContinuation: () => {},
      signal: new AbortController().signal,
      logger,
    }),
  ).toBeUndefined();
  return runId;
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
      const runId = await runFoldTask(db);
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

  // timeout: three backlog boundaries each exercise two real governed scheduler runs and their pacing.
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
                expect(
                  await rejectionOf(
                    db.transaction(async (tx) => {
                      const caseDb = asTestRaw<SchedulerDb>(tx);
                      const sourceId = createSafeId<"caseLawSource">();
                      await tx.insert(caseLawSources).values({
                        id: sourceId,
                        adapterKey: `cap-${sourceId}`,
                        name: "Backlog cap fixture",
                      });
                      const baseline =
                        await readCaseLawPopulationBucketCount(caseDb);
                      const count =
                        CASE_LAW_POPULATION_DELTA_BACKLOG_LIMIT + offset;
                      await appendDeltas(caseDb, sourceId, count);
                      const read = await Result.tryPromise({
                        try: async () =>
                          await tx.transaction(
                            async (readTx) =>
                              await readCaseLawPopulationBucketCount(
                                asTestRaw<SchedulerDb>(readTx),
                              ),
                          ),
                        catch: getPgErrorCode,
                      });
                      if (offset > 0) {
                        expect(read.isErr()).toBe(true);
                        if (read.isErr()) {
                          expect(read.error).toBe("55000");
                        }
                        await runFoldTask(caseDb);
                        await runFoldTask(caseDb);
                        expect(
                          await readCaseLawPopulationBucketCount(caseDb),
                        ).toEqual({ buckets: baseline.buckets + 1 });
                        expect(
                          await tx
                            .select()
                            .from(caseLawPopulationDeltas)
                            .where(
                              eq(caseLawPopulationDeltas.sourceId, sourceId),
                            ),
                        ).toEqual([]);
                      } else {
                        expect(read.isOk()).toBe(true);
                        if (read.isOk()) {
                          expect(read.value).toEqual({
                            buckets: baseline.buckets + 1,
                          });
                        }
                      }
                      expect(
                        await tx
                          .select({ total: caseLawPopulationCountsLive.total })
                          .from(caseLawPopulationCountsLive)
                          .where(
                            eq(caseLawPopulationCountsLive.sourceId, sourceId),
                          ),
                      ).toEqual([{ total: count }]);
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
  ); // timeout: shuffled boundary cases seed the full bounded queue and exercise overflow recovery through the real scheduler.
});
