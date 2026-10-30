import { panic, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import {
  caseLawCoverageSummaries,
  caseLawDecisions,
  caseLawPopulationCounts,
  caseLawSources,
  publishedCaseLawDecisions,
  schedulerJobs,
  unredactedCaseLawDecisions,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { readCaseLawCoverageSourcesQuery } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import {
  decisionDateNotBeforeFilingYearSql,
  decisionDateWithinBoundsSql,
} from "@/api/lib/decision-date-bounds-sql";
import { storedObservationIsListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  createCaseLawCoverageRefreshTask,
  REFRESH_CASE_LAW_COVERAGE_TASK,
} from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
class FixtureRollback extends TaggedError("FixtureRollback")<{
  message: string;
}> {}

const PROPERTY_ID =
  "maintained coverage counts equal fresh aggregation after arbitrary decision writes";

const operation = fc.record({
  type: fc.constantFrom("upsert", "delete"),
  slot: fc.integer({ min: 0, max: 5 }),
  source: fc.integer({ min: 0, max: 1 }),
  court: fc.constantFrom("Court A", "Court B", "", " Court A "),
  country: fc.constantFrom("CZE", "SVK"),
  decisionDate: fc.constantFrom(null, "1998-01-02", "2020-03-04", "2025-05-06"),
  caseNumber: fc.constantFrom("fixture", "1 Cdo 12/2025"),
  publication: fc.constantFrom("published", "listing-only", "redacted"),
});

const assertFreshAggregation = async (
  db: GatedTestDb,
  sourceIds: readonly SafeId<"caseLawSource">[],
) => {
  const published = sql`SELECT * FROM ${publishedCaseLawDecisions}
    WHERE ${inArray(publishedCaseLawDecisions.sourceId, [...sourceIds])}`;
  const pending = sql`SELECT * FROM ${unredactedCaseLawDecisions}
    WHERE ${inArray(unredactedCaseLawDecisions.sourceId, [...sourceIds])}
      AND ${unredactedCaseLawDecisions.fulltext} IS NULL
      AND ${storedObservationIsListingOnly(unredactedCaseLawDecisions.metadata)}`;
  const expected = await db.execute(sql`
    WITH published AS MATERIALIZED (${published}), pending AS MATERIALIZED (${pending}),
    expected AS (
      SELECT 'country' AS kind, country, source_id, country AS value, count(*)::integer AS total
      FROM published GROUP BY country, source_id
      UNION ALL
      SELECT 'court', country, source_id, court, count(*)::integer
      FROM published GROUP BY country, source_id, court
      UNION ALL
      SELECT 'year', country, source_id, to_char(decision_date, 'YYYY'), count(*)::integer
      FROM published WHERE decision_date IS NOT NULL
      GROUP BY country, source_id, to_char(decision_date, 'YYYY')
      UNION ALL
      SELECT 'coverage-year', country, source_id, extract(year FROM decision_date)::integer::text, count(*)::integer
      FROM published d WHERE decision_date IS NOT NULL
        AND ${decisionDateWithinBoundsSql(sql`d.decision_date`, sql`d.country`)}
        AND ${decisionDateNotBeforeFilingYearSql({ date: sql`d.decision_date`, country: sql`d.country`, caseNumber: sql`d.case_number` })}
      GROUP BY country, source_id, extract(year FROM decision_date)::integer::text
      UNION ALL
      SELECT 'pending-text', country, source_id, '', count(*)::integer
      FROM pending GROUP BY country, source_id
    ) SELECT kind, country, source_id AS "sourceId", value, total FROM expected
    ORDER BY kind, country, source_id, value`);
  const actual = await db
    .select()
    .from(caseLawPopulationCounts)
    .where(inArray(caseLawPopulationCounts.sourceId, [...sourceIds]))
    .orderBy(
      caseLawPopulationCounts.kind,
      caseLawPopulationCounts.country,
      caseLawPopulationCounts.sourceId,
      caseLawPopulationCounts.value,
    );
  expect(actual).toEqual([...expected]);
};

describe.skipIf(!enabled)("incremental coverage counts (postgres)", () => {
  // timeout: the real governed runtime checkpoints and publishes inside nested PostgreSQL transactions.
  test("coverage refresh reads maintained counts with the configured search provider", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Coverage refresh proof requires DATABASE_URL");
    // Run this proof with LEGAL_SEARCH_PROVIDER=corpus-index to exercise production's provider configuration.
    expect(envBase.LEGAL_SEARCH_PROVIDER).toBe(
      process.env["LEGAL_SEARCH_PROVIDER"] ?? "pg-fts",
    );
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      let seeded = false;
      while (!seeded) {
        // db-await-in-loop: bounded production seed batches finish the isolated test database before coverage admission.
        const batch = await db.execute(
          sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
        );
        seeded = batch.at(0)?.["done"] === true;
      }
      const rollback = new FixtureRollback({
        message: "Roll back coverage refresh proof",
      });
      expect(
        await rejectionOf(
          db.transaction(async (tx) => {
            const sourceId = createSafeId<"caseLawSource">();
            await tx.insert(caseLawSources).values({
              id: sourceId,
              adapterKey: `provider-proof-${sourceId}`,
              name: "Provider coverage fixture",
            });
            await tx.insert(caseLawDecisions).values({
              id: createSafeId<"caseLawDecision">(),
              sourceId,
              caseNumber: "provider fixture",
              court: "Provider court",
              country: "CZE",
              language: "cs",
              fulltext: "Provider-independent publication",
              decisionDate: "2020-01-01",
            });
            const [job] = await tx
              .insert(schedulerJobs)
              .values({
                id: `coverage-provider-${sourceId}`,
                description: "Coverage provider fixture",
                nextRunAt: new Date("2026-10-01T12:00:00Z"),
                schedule: { type: "interval", everyMs: 300_000 },
                task: REFRESH_CASE_LAW_COVERAGE_TASK,
              })
              .returning();
            if (!job) {
              panic("Coverage provider scheduler fixture was not inserted");
            }
            const task = createCaseLawCoverageRefreshTask({
              createRuntime: (options) =>
                createScriptBackfillRuntime({
                  ...options,
                  readVerdict: async () => ({ kind: "normal", signals: [] }),
                  slot: { tryAcquire: async () => true, release: () => {} },
                }),
              compute: async (readDb) => {
                const rows = await readDb(
                  async (readTx) =>
                    await readCaseLawCoverageSourcesQuery(
                      asTestRaw<CaseLawPublicReadTransaction>(readTx),
                    ),
                );
                expect(rows.find(({ id }) => id === sourceId)).toMatchObject({
                  publishedDecisions: 1,
                  courts: [{ court: "Provider court", decisions: 1 }],
                });
                return {
                  complete: true,
                  answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
                };
              },
            });
            expect(
              await task({
                db: asTestRaw<SchedulerDb>(tx),
                job,
                dueAt: DueSlot.of(job),
                payload: null,
                runId: createSafeId<"schedulerJobRun">(),
                scheduleContinuation: () => {},
                signal: new AbortController().signal,
                logger,
              }),
            ).toBeUndefined();
            const [summary] = await tx
              .select()
              .from(caseLawCoverageSummaries)
              .where(eq(caseLawCoverageSummaries.key, "current"));
            expect(summary?.answer).toEqual(CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE);
            abortTransaction(rollback);
          }),
        ),
      ).toBe(rollback);
    });
  });

  // timeout: the production seed checkpoints bounded legacy batches before replay verification.
  test("bounded legacy coverage seed converges with writes and replay", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Coverage seed proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const rollback = new FixtureRollback({
        message: "Roll back legacy seed proof",
      });
      expect(
        await rejectionOf(
          db.transaction(async (tx) => {
            const sourceId = createSafeId<"caseLawSource">();
            const sourceIds = [sourceId];
            await tx.insert(caseLawSources).values({
              id: sourceId,
              adapterKey: `legacy-coverage-${sourceId}`,
              name: "Legacy coverage fixture",
            });
            await tx.execute(
              sql`ALTER TABLE public.case_law_decisions DISABLE TRIGGER case_law_population_decision_write`,
            );
            const rows = Array.from({ length: 5 }, (_, index) => ({
              id: createSafeId<"caseLawDecision">(),
              sourceId,
              country: "CZE",
              language: "cs",
              court: "Legacy court",
              caseNumber: `legacy/${index}`,
              decisionDate: "2020-01-01",
              fulltext: "Legacy text",
            }));
            await tx.insert(caseLawDecisions).values(rows);
            await tx.execute(
              sql`ALTER TABLE public.case_law_decisions ENABLE TRIGGER case_law_population_decision_write`,
            );
            expect(
              await tx
                .select()
                .from(caseLawPopulationCounts)
                .where(eq(caseLawPopulationCounts.sourceId, sourceId)),
            ).toEqual([]);
            await tx.execute(
              sql`UPDATE public.case_law_population_seed_state SET source_id = NULL, cursor = NULL, completed = false WHERE slot = 0`,
            );
            const firstBatch = await tx.execute(
              sql`SELECT * FROM public.seed_case_law_population_counts(2)`,
            );
            expect(firstBatch.at(0)?.["processed"]).toBe(2);
            expect(firstBatch.at(0)?.["done"]).toBe(false);
            const changed = rows.at(-1) ?? panic("Missing unseeded legacy row");
            await tx
              .update(caseLawDecisions)
              .set({ court: "Reclassified court", country: "SVK" })
              .where(eq(caseLawDecisions.id, changed.id));
            const deleted = rows.at(0) ?? panic("Missing seeded legacy row");
            await tx
              .delete(caseLawDecisions)
              .where(eq(caseLawDecisions.id, deleted.id));
            let done = false;
            while (!done) {
              // db-await-in-loop: exercise the production cursor one bounded batch at a time after interleaved writes.
              const batch = await tx.execute(
                sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
              );
              expect(Number(batch.at(0)?.["processed"])).toBeLessThanOrEqual(
                2048,
              );
              done = batch.at(0)?.["done"] === true;
            }
            await assertFreshAggregation(asTestRaw<GatedTestDb>(tx), sourceIds);
            const replay = await tx.execute(
              sql`SELECT * FROM public.seed_case_law_population_counts(2)`,
            );
            expect(replay.at(0)).toMatchObject({ processed: 0, done: true });
            await assertFreshAggregation(asTestRaw<GatedTestDb>(tx), sourceIds);
            abortTransaction(rollback);
          }),
        ),
      ).toBe(rollback);
    });
  }, 30_000);

  // timeout: two PostgreSQL sessions race a legacy seed with a classification write.
  test("legacy coverage seed and concurrent reclassification converge", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Concurrent coverage seed proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const { db: writer } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      const decisionId = createSafeId<"caseLawDecision">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `coverage-race-${sourceId}`,
        name: "Coverage race fixture",
      });
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`ALTER TABLE public.case_law_decisions DISABLE TRIGGER case_law_population_decision_write`,
          );
          await tx.insert(caseLawDecisions).values({
            id: decisionId,
            sourceId,
            caseNumber: "Legacy race",
            court: "Before race",
            country: "CZE",
            language: "cs",
            fulltext: "Legacy race text",
            decisionDate: "2020-01-01",
          });
          await tx.execute(
            sql`ALTER TABLE public.case_law_decisions ENABLE TRIGGER case_law_population_decision_write`,
          );
          await tx.execute(
            sql`UPDATE public.case_law_population_seed_state SET source_id = NULL, cursor = NULL, completed = false WHERE slot = 0`,
          );
        });
        await Promise.all([
          db.execute(
            sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
          ),
          writer
            .update(caseLawDecisions)
            .set({
              court: "After race",
              country: "SVK",
              decisionDate: "2025-01-01",
            })
            .where(eq(caseLawDecisions.id, decisionId)),
        ]);
        let done = false;
        while (!done) {
          // db-await-in-loop: finish bounded seed batches after the competing transactions settle.
          const batch = await db.execute(
            sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
          );
          done = batch.at(0)?.["done"] === true;
        }
        await assertFreshAggregation(db, [sourceId]);
      } finally {
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.id, decisionId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  }, 30_000);

  // timeout: competing bulk writers exercise PostgreSQL row and aggregate-key locks.
  test("concurrent bulk writers preserve hot source and court buckets", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Concurrent writer proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const { db: writer } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `coverage-writers-${sourceId}`,
        name: "Coverage writers fixture",
      });
      const rows = Array.from({ length: 48 }, (_, index) => ({
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: `writer/${index}`,
        country: "CZE",
        language: "cs",
        court: "Hot court",
        decisionDate: "2020-01-01",
        fulltext: "Initial text",
      }));
      const firstIds = rows.slice(0, 24).map(({ id }) => id);
      const secondIds = rows.slice(24).map(({ id }) => id);
      try {
        await Promise.all([
          db.insert(caseLawDecisions).values(rows.slice(0, 24)),
          writer.insert(caseLawDecisions).values(rows.slice(24)),
        ]);
        await assertFreshAggregation(db, [sourceId]);
        await Promise.all([
          db
            .update(caseLawDecisions)
            .set({
              court: "Reparsed hot court",
              fulltext: "Reparsed first batch",
            })
            .where(inArray(caseLawDecisions.id, firstIds)),
          writer
            .update(caseLawDecisions)
            .set({
              court: "Reparsed hot court",
              fulltext: "Reparsed second batch",
            })
            .where(inArray(caseLawDecisions.id, secondIds)),
        ]);
        await assertFreshAggregation(db, [sourceId]);
      } finally {
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  }, 30_000);

  test("no-op decision updates preserve coverage counter tuple versions", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Coverage no-op proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `coverage-no-op-${sourceId}`,
        name: "Coverage no-op fixture",
      });
      try {
        await db.insert(caseLawDecisions).values({
          id: createSafeId<"caseLawDecision">(),
          sourceId,
          caseNumber: "No-op fixture",
          court: "Stable court",
          country: "CZE",
          language: "cs",
          fulltext: "Stable text",
          decisionDate: "2020-01-01",
        });
        const before =
          await db.execute(sql`SELECT kind, country, value, total, xmin::text, ctid::text
          FROM public.case_law_population_counts WHERE source_id = ${sourceId} ORDER BY kind, country, value`);
        expect(before.length).toBeGreaterThan(0);
        await db.execute(sql`UPDATE public.case_law_decisions SET source_id = source_id, country = country,
          court = court, decision_date = decision_date, case_number = case_number, metadata = metadata,
          redacted_at = redacted_at, fulltext = fulltext WHERE source_id = ${sourceId}`);
        const after =
          await db.execute(sql`SELECT kind, country, value, total, xmin::text, ctid::text
          FROM public.case_law_population_counts WHERE source_id = ${sourceId} ORDER BY kind, country, value`);
        expect([...after]).toEqual([...before]);
        await assertFreshAggregation(db, [sourceId]);
      } finally {
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  });

  // timeout: real PostgreSQL checks the aggregate after every generated transition.
  test(
    PROPERTY_ID,
    async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("Coverage count property requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const sourceIds = [
          createSafeId<"caseLawSource">(),
          createSafeId<"caseLawSource">(),
        ];
        const decisions = Array.from({ length: 6 }, () =>
          createSafeId<"caseLawDecision">(),
        );
        await db.insert(caseLawSources).values(
          sourceIds.map((id) => ({
            id,
            adapterKey: `coverage-property-${id}`,
            name: "Coverage property fixture",
          })),
        );
        try {
          await assertProperty(
            PROPERTY_ID,
            fc.asyncProperty(
              fc.array(operation, { minLength: 5, maxLength: 25 }),
              async (operations) => {
                await db
                  .delete(caseLawDecisions)
                  .where(inArray(caseLawDecisions.sourceId, sourceIds));
                for (const input of operations) {
                  const id =
                    decisions.at(input.slot) ??
                    panic("Missing generated decision slot");
                  if (input.type === "delete") {
                    // db-await-in-loop: exercise each state-machine transition and compare its committed aggregate.
                    await db
                      .delete(caseLawDecisions)
                      .where(eq(caseLawDecisions.id, id));
                  } else {
                    const sourceId =
                      sourceIds.at(input.source) ??
                      panic("Missing generated source slot");
                    const row = {
                      id,
                      sourceId,
                      sourceDocumentId: id,
                      country: input.country,
                      court: input.court,
                      language: "cs",
                      decisionDate: input.decisionDate,
                      caseNumber: input.caseNumber,
                      fulltext:
                        input.publication === "published"
                          ? "Fixture text"
                          : null,
                      redactedAt:
                        input.publication === "redacted"
                          ? new Date("2026-01-01T00:00:00Z")
                          : null,
                      metadata:
                        input.publication === "listing-only"
                          ? {
                              _stellaPartialObservation: {
                                isListingOnly: true,
                              },
                            }
                          : {},
                    };
                    // db-await-in-loop: real insert/upsert writes exercise trigger transitions, including source and country changes.
                    await db
                      .insert(caseLawDecisions)
                      .values(row)
                      .onConflictDoUpdate({
                        target: caseLawDecisions.id,
                        set: row,
                      });
                  }
                  // db-await-in-loop: the invariant must hold after every generated write, including deletes and no-op replay.
                  await assertFreshAggregation(db, sourceIds);
                }
              },
            ),
            { numRuns: 30 },
          );
        } finally {
          await db
            .delete(caseLawDecisions)
            .where(inArray(caseLawDecisions.sourceId, sourceIds));
          await db
            .delete(caseLawSources)
            .where(inArray(caseLawSources.id, sourceIds));
        }
      });
    },
    120_000,
  );
});
