import { panic, Result, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { waitForExternalState } from "@stll/property-testing/external-state";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import {
  caseLawCoverageSummaries,
  caseLawDecisions,
  caseLawPopulationCounts,
  caseLawPopulationCountsLive,
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
import { getPgErrorCode } from "@/api/lib/pg-error";
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
    .from(caseLawPopulationCountsLive)
    .where(inArray(caseLawPopulationCountsLive.sourceId, [...sourceIds]))
    .orderBy(
      caseLawPopulationCountsLive.kind,
      caseLawPopulationCountsLive.country,
      caseLawPopulationCountsLive.sourceId,
      caseLawPopulationCountsLive.value,
    );
  expect<readonly Record<string, unknown>[]>(actual).toEqual([...expected]);
  return actual;
};

const populationDecisionRow = (
  sourceId: SafeId<"caseLawSource">,
  country: string,
) => {
  const id = createSafeId<"caseLawDecision">();
  return {
    id,
    sourceId,
    sourceDocumentId: id,
    caseNumber: id,
    country,
    language: "cs",
    court: "Overlapping court",
    decisionDate: "2020-01-01",
    fulltext: "Published fixture",
  };
};

const foldPopulationCounts = async (db: GatedTestDb, namespace = "public") => {
  let done = false;
  while (!done) {
    // db-await-in-loop: drain only bounded production delta-fold batches before checking the persisted owner.
    const rows = await db.execute(
      sql`SELECT * FROM ${sql.identifier(namespace)}.fold_case_law_population_counts(2048)`,
    );
    done = rows.at(0)?.["done"] === true;
  }
};

const assertFoldedAggregation = async (
  db: GatedTestDb,
  sourceIds: readonly SafeId<"caseLawSource">[],
  namespace = "public",
) => {
  await foldPopulationCounts(db, namespace);
  const live = await assertFreshAggregation(db, sourceIds);
  const persisted = await db
    .select()
    .from(caseLawPopulationCounts)
    .where(inArray(caseLawPopulationCounts.sourceId, [...sourceIds]))
    .orderBy(
      caseLawPopulationCounts.kind,
      caseLawPopulationCounts.country,
      caseLawPopulationCounts.sourceId,
      caseLawPopulationCounts.value,
    );
  expect(persisted).toEqual(live);
};

const createPopulationFixture = async (db: GatedTestDb, schemaName: string) => {
  const schema = sql.identifier(schemaName);
  await db.execute(sql`CREATE SCHEMA ${schema}`);
  for (const name of ["case_law_sources", "case_law_decisions"]) {
    // db-await-in-loop: clone the two canonical inputs while isolating unrelated corpus writers from the population lock-order proof.
    await db.execute(
      sql`CREATE TABLE ${schema}.${sql.identifier(name)} (LIKE public.${sql.identifier(name)} INCLUDING ALL)`,
    );
  }
  await db.execute(sql`SET search_path TO ${schema}, public`);
  const dialect = new PgDialect();
  for (const view of [publishedCaseLawDecisions, unredactedCaseLawDecisions]) {
    const config = getViewConfig(view);
    // db-await-in-loop: install both production publication views over the isolated input table.
    await db.execute(
      sql`CREATE VIEW ${schema}.${sql.identifier(config.name)} AS (${sql.raw(dialect.sqlToQuery(config.query).sql)})`,
    );
  }
  const migration = await Bun.file(
    new URL(
      "../../../../drizzle/20261101022151_case_law_population_counts/migration.sql",
      import.meta.url,
    ),
  ).text();
  const isolated = migration.replaceAll(
    /\bpublic\.([a-z_]*case_law_population[a-z_]*|case_law_decisions|case_law_sources)\b/gu,
    (match) => match.replace("public.", () => `"${schemaName}".`),
  );
  for (const statement of isolated.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") {
      // db-await-in-loop: exercise the committed owner tables, views, policies and triggers without reproducing their SQL in the oracle.
      await db.execute(sql.raw(statement));
    }
  }
};

describe.skipIf(!enabled)("incremental coverage counts (postgres)", () => {
  // timeout: the real governed runtime checkpoints and publishes inside nested PostgreSQL transactions.
  test("coverage refresh reads maintained counts with the configured search provider", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Coverage refresh proof requires DATABASE_URL");
    // Run this proof with LEGAL_SEARCH_PROVIDER=corpus-index to exercise production's provider configuration.
    expect<string>(envBase.LEGAL_SEARCH_PROVIDER).toBe(
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
                      [],
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
              sql`UPDATE public.case_law_population_seed_state SET source_id = NULL, cursor = NULL, phase = 'scan' WHERE slot = 0`,
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
            sql`UPDATE public.case_law_population_seed_state SET source_id = NULL, cursor = NULL, phase = 'scan' WHERE slot = 0`,
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

  // timeout: a second PostgreSQL session holds a decision through a seed batch.
  test("a seed batch stops before a busy decision and never passes it", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Busy decision coverage seed proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const { db: writer } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      const decisionIds = [
        createSafeId<"caseLawDecision">(),
        createSafeId<"caseLawDecision">(),
        createSafeId<"caseLawDecision">(),
      ].toSorted();
      const firstId =
        decisionIds.at(0) ?? panic("Busy decision fixture needs its first row");
      const busyId =
        decisionIds.at(1) ?? panic("Busy decision fixture needs its busy row");
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `coverage-busy-${sourceId}`,
        name: "Coverage busy decision fixture",
      });
      const projected = async () =>
        (
          await db.execute(
            sql`SELECT decision_id FROM public.case_law_population_projections WHERE source_id = ${sourceId} ORDER BY decision_id`,
          )
        ).map((row) => row["decision_id"]);
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`ALTER TABLE public.case_law_decisions DISABLE TRIGGER case_law_population_decision_write`,
          );
          await tx.insert(caseLawDecisions).values(
            decisionIds.map((id, index) => ({
              id,
              sourceId,
              caseNumber: `Busy ${String(index)}`,
              court: "Busy court",
              country: "CZE",
              language: "cs",
              fulltext: "Busy decision text",
              decisionDate: "2020-01-01",
            })),
          );
          await tx.execute(
            sql`ALTER TABLE public.case_law_decisions ENABLE TRIGGER case_law_population_decision_write`,
          );
          await tx.execute(
            sql`UPDATE public.case_law_population_seed_state SET phase = 'scan', source_id = ${sourceId}, cursor = NULL WHERE slot = 0`,
          );
        });
        const release = Promise.withResolvers<undefined>();
        const held = Promise.withResolvers<undefined>();
        const holder = writer.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM public.case_law_decisions WHERE id = ${busyId} FOR UPDATE`,
          );
          held.resolve(undefined);
          await release.promise;
        });
        await held.promise;
        try {
          const batch = await db.execute(
            sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
          );
          expect(batch.at(0)?.["cursor"]).toBe(firstId);
          expect(batch.at(0)?.["processed"]).toBe(1);
          expect(await projected()).toEqual([firstId]);
        } finally {
          release.resolve(undefined);
          await holder;
        }
        let done = false;
        while (!done) {
          // db-await-in-loop: finish bounded seed batches after the writer commits
          const batch = await db.execute(
            sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
          );
          done = batch.at(0)?.["done"] === true;
        }
        expect(await projected()).toEqual(decisionIds);
        await assertFreshAggregation(db, [sourceId]);
      } finally {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, decisionIds));
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
        await foldPopulationCounts(db);
        const pendingBefore =
          await db.execute(sql`SELECT id, kind, country, value, delta, xmin::text, ctid::text
          FROM public.case_law_population_deltas WHERE source_id = ${sourceId} ORDER BY id`);
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
        const pendingAfter =
          await db.execute(sql`SELECT id, kind, country, value, delta, xmin::text, ctid::text
          FROM public.case_law_population_deltas WHERE source_id = ${sourceId} ORDER BY id`);
        expect([...pendingAfter]).toEqual([...pendingBefore]);
        await assertFreshAggregation(db, [sourceId]);
      } finally {
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  });

  // timeout: PostgreSQL barriers overlap the update and insert phases before the server resolves lock dependencies.
  test("mixed upsert phases across sources and countries commit without counter deadlocks", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Mixed upsert proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const { db: firstWriter } = openClient({ max: 1 });
      const { db: secondWriter } = openClient({ max: 1 });
      const sourceIds = [
        createSafeId<"caseLawSource">(),
        createSafeId<"caseLawSource">(),
      ];
      const firstSource =
        sourceIds.at(0) ?? panic("Missing first phase source");
      const secondSource =
        sourceIds.at(1) ?? panic("Missing second phase source");
      const firstExisting = populationDecisionRow(firstSource, "CZE");
      const secondExisting = populationDecisionRow(secondSource, "SVK");
      const firstBatch = [
        firstExisting,
        populationDecisionRow(secondSource, "SVK"),
      ];
      const secondBatch = [
        secondExisting,
        populationDecisionRow(firstSource, "CZE"),
      ];
      const schemaName = `coverage_phase_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await createPopulationFixture(db, schemaName);
      await Promise.all(
        [firstWriter, secondWriter].map(
          async (writer) =>
            await writer.execute(sql`SET search_path TO ${schema}, public`),
        ),
      );
      await db.insert(caseLawSources).values(
        sourceIds.map((id) => ({
          id,
          adapterKey: `coverage-phase-${id}`,
          name: "Coverage phase fixture",
        })),
      );
      try {
        await db.insert(caseLawDecisions).values(
          [firstExisting, secondExisting].map((row) => ({
            ...row,
            fulltext: null,
            metadata: { _stellaPartialObservation: { isListingOnly: true } },
          })),
        );
        await foldPopulationCounts(db, schemaName);
        await db.execute(sql`CREATE FUNCTION ${schema}.pause_after_projection_update() RETURNS trigger
          LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
          BEGIN
            IF nullif(current_setting('stella.coverage_phase_gate', true), '') IS NOT NULL THEN
              PERFORM pg_advisory_xact_lock(19054, current_setting('stella.coverage_phase_gate')::integer);
            END IF;
            RETURN NULL;
          END $function$`);
        await db.execute(sql`CREATE TRIGGER zz_coverage_phase_gate AFTER UPDATE ON ${schema}.case_law_population_projections
          FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.pause_after_projection_update()`);
        await db.execute(
          sql`SELECT pg_advisory_lock(19054, 1), pg_advisory_lock(19054, 2)`,
        );
        const run = async (
          writer: GatedTestDb,
          gate: number,
          rows: ReturnType<typeof populationDecisionRow>[],
        ) =>
          await Result.tryPromise({
            try: async () =>
              await writer.transaction(async (tx) => {
                await tx.execute(sql`SELECT set_config('statement_timeout', '10s', true), set_config('lock_timeout', '0', true),
              set_config('stella.coverage_phase_gate', ${String(gate)}, true)`);
                await tx
                  .insert(caseLawDecisions)
                  .values(rows)
                  .onConflictDoUpdate({
                    target: caseLawDecisions.id,
                    set: { fulltext: "Published after conflict", metadata: {} },
                  });
              }),
            catch: (cause: unknown) => cause,
          });
        const pending = [
          run(firstWriter, 1, firstBatch),
          run(secondWriter, 2, secondBatch),
        ];
        const barrier = await Result.tryPromise(
          async () =>
            await waitForExternalState({
              description:
                "both mixed upserts reached the projection update phase",
              read: async () => {
                const waiting =
                  await db.execute(sql`SELECT count(*)::integer AS waiting FROM pg_locks
              WHERE locktype = 'advisory' AND classid = 19054 AND objid IN (1, 2) AND NOT granted`);
                return waiting.at(0)?.["waiting"] === 2;
              },
            }),
        );
        await db.execute(
          sql`SELECT pg_advisory_unlock(19054, 1), pg_advisory_unlock(19054, 2)`,
        );
        const outcomes = await Promise.all(pending);
        expect(
          barrier.isOk(),
          "Both writers must reach the catalog-observed phase barrier",
        ).toBe(true);
        const failures = outcomes.flatMap((outcome) =>
          outcome.isErr() ? [getPgErrorCode(outcome.error)] : [],
        );
        expect(
          failures,
          `Mixed upsert SQLSTATEs: ${JSON.stringify(failures)}`,
        ).toEqual([]);
        await assertFreshAggregation(db, sourceIds);
        await assertFoldedAggregation(db, sourceIds, schemaName);
      } finally {
        await db.execute(sql`SELECT pg_advisory_unlock_all()`);
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 30_000);

  // timeout: two real transactions retain their first statement's locks while crossing the second statement's source order.
  test("opposite source order across transaction statements commits without counter deadlocks", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Transaction source-order proof requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const { db: firstWriter } = openClient({ max: 1 });
      const { db: secondWriter } = openClient({ max: 1 });
      const sourceIds = [
        createSafeId<"caseLawSource">(),
        createSafeId<"caseLawSource">(),
      ];
      const firstSource =
        sourceIds.at(0) ?? panic("Missing first transaction source");
      const secondSource =
        sourceIds.at(1) ?? panic("Missing second transaction source");
      const schemaName = `coverage_order_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await createPopulationFixture(db, schemaName);
      await Promise.all(
        [firstWriter, secondWriter].map(
          async (writer) =>
            await writer.execute(sql`SET search_path TO ${schema}, public`),
        ),
      );
      await db.insert(caseLawSources).values(
        sourceIds.map((id) => ({
          id,
          adapterKey: `coverage-order-${id}`,
          name: "Coverage order fixture",
        })),
      );
      const firstReady = Promise.withResolvers<undefined>();
      const secondReady = Promise.withResolvers<undefined>();
      const bothReady = Promise.all([firstReady.promise, secondReady.promise]);
      const firstRows = [
        populationDecisionRow(firstSource, "CZE"),
        populationDecisionRow(secondSource, "SVK"),
      ];
      const secondRows = [
        populationDecisionRow(secondSource, "SVK"),
        populationDecisionRow(firstSource, "CZE"),
      ];
      try {
        const run = async (
          writer: GatedTestDb,
          rows: ReturnType<typeof populationDecisionRow>[],
          ready: ReturnType<typeof Promise.withResolvers<undefined>>,
        ) =>
          await Result.tryPromise({
            try: async () =>
              await writer.transaction(async (tx) => {
                await tx.execute(
                  sql`SELECT set_config('statement_timeout', '10s', true), set_config('lock_timeout', '0', true)`,
                );
                const first =
                  rows.at(0) ?? panic("Missing first statement row");
                const second =
                  rows.at(1) ?? panic("Missing second statement row");
                const written = await Result.tryPromise(
                  async () => await tx.insert(caseLawDecisions).values(first),
                );
                ready.resolve(undefined);
                if (written.isErr()) {
                  abortTransaction(written.error);
                }
                await bothReady;
                await tx.insert(caseLawDecisions).values(second);
              }),
            catch: (cause: unknown) => cause,
          });
        const outcomes = await Promise.all([
          run(firstWriter, firstRows, firstReady),
          run(secondWriter, secondRows, secondReady),
        ]);
        const failures = outcomes.flatMap((outcome) =>
          outcome.isErr() ? [getPgErrorCode(outcome.error)] : [],
        );
        expect(
          failures,
          `Opposite statement SQLSTATEs: ${JSON.stringify(failures)}`,
        ).toEqual([]);
        await assertFreshAggregation(db, sourceIds);
        await assertFoldedAggregation(db, sourceIds, schemaName);
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 30_000);

  // timeout: real PostgreSQL checks the aggregate after every generated transition.
  test("maintained coverage counts equal fresh aggregation after arbitrary decision writes", async () => {
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
          "maintained coverage counts equal fresh aggregation after arbitrary decision writes",
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
                      input.publication === "published" ? "Fixture text" : null,
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
  }, 120_000);
});
