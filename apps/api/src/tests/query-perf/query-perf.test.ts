import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import { READ_BUDGETS } from "@/api/lib/db/read-budgets";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusProjectionOutstandingIntentProbe,
  corpusProjectionUnpublishedIntentProbe,
} from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";

import {
  CASE_LAW_SCENARIOS,
  type CaseLawScenarioGeneration,
  describeServed,
  EXPRESSION_ID_BACKFILL_SIZES,
  PROVISION_BACKFILL_SIZES,
  seedCorpusReadBudgets,
  seedExpressionIdBackfillRows,
  seedProvisionBackfillRows,
  serveCaseLaw,
  type ServedCaseLaw,
} from "./corpus-seed";
import { withQueryPerfFixture } from "./fixture";
import {
  budgetProblem,
  budgetViolations,
  measureOwnerStatement,
  measureQueryPerf,
  scaleViolations,
  shapeViolations,
} from "./measurement";
import { QUERY_PERF_PROFILES } from "./profiles";
import {
  corpusStatementRegistry,
  queryPerfRegistry,
  READ_BUDGET_PROFILES,
  SCHEDULED_JOB_MEASUREMENTS,
} from "./registry";
import {
  measureScheduledJobRun,
  statementsForMeasurement,
} from "./scheduled-run";
import { seedQueryPerf } from "./seed";
import { QUERY_PERF_TABLE_SIZES } from "./table-sizes";
import { UNBOUNDED_FRESHNESS_STATEMENTS } from "./unbounded-freshness-fixture";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const CORPUS_PROFILE_TIMEOUT_MS = 300_000;

const log = (record: Record<string, unknown>) => {
  console.info(JSON.stringify(record));
};

const profileBudgets = (profile: "corpus" | "tenant") =>
  Object.entries(READ_BUDGET_PROFILES)
    .filter(([, owner]) => owner === profile)
    .map(([id]) => id)
    .toSorted();

const backfillFixture = (jobId: string) => {
  if (jobId === SCHEDULER_BACKFILL_IDS.provisionState) {
    return {
      seed: seedProvisionBackfillRows,
      sizes: PROVISION_BACKFILL_SIZES,
    };
  }
  if (jobId === SCHEDULER_BACKFILL_IDS.expressionIds) {
    return {
      seed: seedExpressionIdBackfillRows,
      sizes: EXPRESSION_ID_BACKFILL_SIZES,
    };
  }
  return undefined;
};

test("a measured fixture job cannot hide DDL", () => {
  expect(() =>
    statementsForMeasurement("fixture.alter", [
      {
        text: "ALTER TABLE fixture_table VALIDATE CONSTRAINT fixture_check",
        params: [],
      },
    ]),
  ).toThrow(
    "fixture.alter issued unmeasurable DDL: ALTER TABLE fixture_table VALIDATE CONSTRAINT fixture_check",
  );
});

test("query-perf table size declarations name real schema tables", () => {
  const schemaTables: ReadonlySet<string> = new Set(
    Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map(getTableName),
  );
  expect(
    Object.keys(QUERY_PERF_TABLE_SIZES).filter(
      (name) => !schemaTables.has(name),
    ),
  ).toEqual([]);
});

test("every measurement execution guard applies even when pages fit or carry an over-budget marker", () => {
  for (const id of [
    "scheduled.caseLaw.reportFreshness",
    "statement.documents.searchHits",
    "statement.legislation.candidateRows",
  ] as const) {
    for (const sharedBlocks of [
      READ_BUDGETS[id].pages,
      READ_BUDGETS[id].pages + 1,
    ]) {
      expect(
        budgetProblem(id, { sharedBlocks, executionTimeMs: 10_001 }),
      ).toContain("execution time");
    }
  }
});

test("over-budget markers require every measured surface to exceed its page budget", () => {
  for (const id of [
    "scheduled.caseLaw.backfillProvisionState",
    "statement.legislation.candidateRows",
  ] as const) {
    expect(
      budgetProblem(id, {
        sharedBlocks: READ_BUDGETS[id].pages,
        executionTimeMs: 10_000,
      }),
    ).toContain("remove its overBudget marker");
    expect(
      budgetProblem(id, {
        sharedBlocks: READ_BUDGETS[id].pages + 1,
        executionTimeMs: 10_000,
      }),
    ).toBeUndefined();
  }
  expect(
    budgetProblem("statement.documents.searchHits", {
      sharedBlocks: READ_BUDGETS["statement.documents.searchHits"].pages,
      executionTimeMs: 10_000,
    }),
  ).toBeUndefined();
});

describe.skipIf(!enabled)("read budgets on PostgreSQL", () => {
  test("document search stays within its budget at both sizes and a correlated policy exceeds it", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    const measured = new Set<string>();
    for (const profileId of QUERY_PERF_PROFILES) {
      // db-await-in-loop: fresh profile databases must be seeded and measured sequentially to avoid benchmark contention.
      await withQueryPerfFixture({
        databaseUrl,
        profileId,
        run: async (db, deadline) => {
          const seed = await deadline.run(
            "seed",
            async () => await seedQueryPerf(db, profileId),
          );
          expect(seed.context.featureIds).toEqual([]);
          for (const entry of queryPerfRegistry(seed)) {
            const { budgetId } = entry;
            const id = budgetId;
            measured.add(budgetId);
            const budget = READ_BUDGETS[budgetId];
            // db-await-in-loop: one bounded registry measurement at a time, avoiding cross-query benchmark contention.
            const good = await deadline.run(
              `measure ${id}`,
              async () =>
                await measureQueryPerf({
                  database: db,
                  seed,
                  query: entry.query,
                  owner: budgetId,
                  ownerDeadlineMs: entry.ownerDeadlineMs,
                  profileId,
                }),
            );
            log({
              event: "read_budget_measurement",
              profileId,
              budgetId,
              budgetPages: budget.pages,
              ...good.metrics,
              samples: good.samples,
            });
            expect(
              good.plan.Plan["Actual Rows"],
              `actual row budget: measured ${String(good.plan.Plan["Actual Rows"])}; expected ${entry.expectedRows}`,
            ).toBe(entry.expectedRows);
            log({
              event: "read_budget_plan",
              profileId,
              budgetId,
              plan: good.plan.Plan,
            });
            expect(shapeViolations(good.plan, profileId)).toEqual([]);
            expect(good.planViolations.map(({ message }) => message)).toEqual(
              [],
            );
            expect(budgetProblem(budgetId, good.metrics)).toBeUndefined();
            await deadline.run(
              `CREATE POLICY ${id}`,
              async () =>
                await db.execute(sql`CREATE POLICY query_perf_correlated_fixture ON search_documents AS RESTRICTIVE FOR SELECT TO stella USING (
              (SELECT count(*) FROM entities policy_entity WHERE policy_entity.id = search_documents.entity_id) > 0
            )`),
            );
            const bad = await deadline.run(
              `measure policy fixture ${id}`,
              async () =>
                await measureQueryPerf({
                  database: db,
                  seed,
                  query: entry.query,
                  owner: budgetId,
                  ownerDeadlineMs: entry.ownerDeadlineMs,
                  profileId,
                }),
            );
            log({
              event: "read_budget_measurement",
              profileId,
              budgetId,
              fixture: "correlated-policy",
              ...bad.metrics,
            });
            // The fixture must reach the policy at either size, and at the
            // size the budget is stated for it must fail the budget
            // independently of the shape check.
            expect(shapeViolations(bad.plan, profileId)).toContain(
              "per-row policy subplan on search_documents",
            );
            if (profileId === "growth") {
              expect(
                budgetViolations(bad.metrics, budget.pages).map(
                  ({ kind }) => kind,
                ),
              ).toContain("shared-buffer-budget");
            }
            // Failed entries leave the policy in their disposable database for fixture teardown.
            await deadline.run(
              `DROP POLICY ${id}`,
              async () =>
                await db.execute(
                  sql`DROP POLICY IF EXISTS query_perf_correlated_fixture ON search_documents`,
                ),
            );
          }
        },
      });
    }
    expect([...measured].toSorted()).toEqual(profileBudgets("tenant"));
  }, 420_000); // timeout: two fresh databases are seeded and measured; each profile owns a 150-second deadline.

  test("corpus statements and scheduled jobs stay within their budgets at production shape", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    const measured = new Set<string>();
    // Every measurement runs and logs before the verdict, so one run reports
    // all of them.
    const problems: string[] = [];
    const note = (problem: string | undefined) => {
      if (problem !== undefined) {
        problems.push(problem);
      }
    };
    await withQueryPerfFixture({
      databaseUrl,
      profileId: "corpus",
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async (db, deadline, openClient) => {
        const seed = await deadline.run(
          "seed",
          async () => await seedCorpusReadBudgets(db),
        );

        for (const entry of corpusStatementRegistry(seed)) {
          const { budgetId } = entry;
          const id = budgetId;
          measured.add(budgetId);
          // db-await-in-loop: one bounded registry measurement at a time, avoiding cross-query benchmark contention.
          const result = await deadline.run(
            `measure ${id}`,
            async () =>
              await measureOwnerStatement({
                database: db,
                build: entry.build,
                owner: budgetId,
                ownerDeadlineMs: entry.ownerDeadlineMs,
                profileId: "corpus",
              }),
          );
          log({
            event: "read_budget_measurement",
            profileId: "corpus",
            budgetId,
            budgetPages: READ_BUDGETS[budgetId].pages,
            ...result.metrics,
            perRow: result.metrics.sharedBlocks / entry.expectedRows,
          });
          log({
            event: "read_budget_plan",
            profileId: "corpus",
            budgetId,
            plan: result.plan.Plan,
          });
          note(
            result.plan.Plan["Actual Rows"] === entry.expectedRows
              ? undefined
              : `${id}: ${String(result.plan.Plan["Actual Rows"])} rows, expected ${String(entry.expectedRows)}`,
          );
          note(budgetProblem(budgetId, result.metrics));
          for (const violation of result.planViolations) {
            note(violation.message);
          }
        }

        const runMetrics = async (
          jobId: string,
          task: string,
          served?: ServedCaseLaw,
        ) => {
          if (served !== undefined) {
            await serveCaseLaw(db, served);
          }
          const generation =
            served === undefined ? "backfill-source" : describeServed(served);
          const run = await measureScheduledJobRun({
            database: db,
            openClient,
            jobId,
            task,
          });
          log({
            event: "read_budget_job_run",
            jobId,
            generation,
            ...run.metrics,
            statements: run.statements,
          });
          for (const violation of run.planViolations) {
            note(violation.message);
          }
          return run.metrics;
        };
        // Every job that declares a budget, judged against the budget its own
        // registration names; the census makes each one have a measurement.
        for (const job of DECLARED_SCHEDULER_JOBS) {
          if (typeof job.reads !== "object") {
            continue;
          }
          const budgetId = job.reads.budget;
          const jobId = job.id;
          const measurement = SCHEDULED_JOB_MEASUREMENTS[jobId];
          if (measurement === undefined) {
            note(`${jobId} declares ${budgetId} but has no measurement`);
            continue;
          }
          measured.add(budgetId);
          const backfill = backfillFixture(jobId);
          if (backfill !== undefined) {
            const pages: number[] = [];
            for (const rows of [backfill.sizes.base, backfill.sizes.double]) {
              // db-await-in-loop: the source table grows before the second bounded run is measured.
              const result = await deadline.run(
                `run ${jobId} with ${String(rows)} source rows`,
                async () => {
                  await backfill.seed(db, rows);
                  const countResult = await db.execute(
                    jobId === SCHEDULER_BACKFILL_IDS.provisionState
                      ? sql`SELECT count(*)::int AS count FROM case_law_decisions
                          WHERE source_id = '01990000-00c0-7000-8000-000000000001'::uuid`
                      : sql`SELECT count(*)::int AS count FROM legislation_documents
                          WHERE publisher_expression_id IS NULL`,
                  );
                  const countRow = executedRows(countResult).at(0);
                  const count =
                    typeof countRow === "object" &&
                    countRow !== null &&
                    "count" in countRow
                      ? countRow.count
                      : undefined;
                  expect(
                    count,
                    `${jobId} fixture must grow to ${String(rows)} source rows`,
                  ).toBe(rows);
                  return await runMetrics(jobId, measurement.task);
                },
              );
              pages.push(result.sharedBlocks);
              note(budgetProblem(budgetId, result));
            }
            const size =
              pages.at(0) ?? panic("missing base backfill measurement");
            const double =
              pages.at(1) ?? panic("missing double backfill measurement");
            for (const violation of scaleViolations({ size, double })) {
              note(`${jobId} on backfill source rows: ${violation}`);
            }
            continue;
          }
          for (const scenario of measurement.scenarios) {
            const label = describeServed(scenario.size);
            // db-await-in-loop: scenarios move the served generations, so they run one at a time.
            const size = await deadline.run(
              `run ${jobId} on ${label}`,
              async () =>
                await runMetrics(jobId, measurement.task, scenario.size),
            );
            note(budgetProblem(budgetId, size));
            const twin = scenario.double;
            if (twin === undefined) {
              continue;
            }
            // db-await-in-loop: the twin scenario moves the served generations after the first run finished.
            const double = await deadline.run(
              `run ${jobId} on ${describeServed(twin)}`,
              async () => await runMetrics(jobId, measurement.task, twin),
            );
            note(budgetProblem(budgetId, double));
            for (const violation of scaleViolations({
              size: size.sharedBlocks,
              double: double.sharedBlocks,
            })) {
              note(`${jobId} on ${label}: ${violation}`);
            }
          }
        }

        // The gate must refuse what it exists to refuse. The freshness
        // report's former reads go over its budget on this fixture, and the
        // census-readiness revision checks, which it no longer runs, grow
        // with the generation.
        const unbounded = await deadline.run(
          "measure unbounded freshness reads",
          async () => {
            let pages = 0;
            for (const query of UNBOUNDED_FRESHNESS_STATEMENTS) {
              // db-await-in-loop: two fixed statements, measured one at a time.
              const result = await measureOwnerStatement({
                database: db,
                build: () => query,
                owner: "fixture.unboundedFreshness",
                ownerDeadlineMs: undefined,
                profileId: "corpus",
              });
              pages += result.metrics.sharedBlocks;
            }
            return pages;
          },
        );
        log({
          event: "read_budget_refusal",
          fixture: "unbounded-freshness",
          pages: unbounded,
        });
        note(
          unbounded > READ_BUDGETS["scheduled.caseLaw.reportFreshness"].pages
            ? undefined
            : `the former unbounded freshness reads measured ${String(unbounded)} pages, inside the job's budget: the fixture is too small to refuse them`,
        );

        const revisionChecks = async (
          generation: CaseLawScenarioGeneration,
        ) => {
          const target = { family: "case_law" as const, generation };
          let pages = 0;
          for (const query of [
            corpusProjectionOutstandingIntentProbe(target),
            corpusProjectionUnpublishedIntentProbe(
              target,
              CORPUS_INDEX_MANIFESTS[generation],
            ),
          ]) {
            // db-await-in-loop: the two revision checks, measured one at a time.
            const result = await measureOwnerStatement({
              database: db,
              build: () => query,
              owner: "fixture.convergenceRevisionChecks",
              ownerDeadlineMs: undefined,
              profileId: "corpus",
            });
            pages += result.metrics.sharedBlocks;
          }
          return pages;
        };
        const quiet = CASE_LAW_SCENARIOS.quiet;
        const growth = await deadline.run(
          "measure revision checks",
          async () => ({
            size: await revisionChecks(quiet.size.serving),
            double: await revisionChecks(quiet.double.serving),
          }),
        );
        log({
          event: "read_budget_refusal",
          fixture: "convergence-revision-checks",
          ...growth,
        });
        note(
          scaleViolations(growth).length > 0
            ? undefined
            : `the revision checks read ${String(growth.size)} and ${String(growth.double)} pages: the scale rule did not refuse them`,
        );
      },
    });
    expect(problems).toEqual([]);
    expect([...measured].toSorted()).toEqual(profileBudgets("corpus"));
  }, 420_000); // timeout: the corpus profile seeds about a million rows inside its own 300-second deadline.
});
