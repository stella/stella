import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { executedRows } from "@/api/lib/db/executed-rows";
import { READ_BUDGETS } from "@/api/lib/db/read-budgets";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusProjectionOutstandingIntentProbe,
  corpusProjectionUnpublishedIntentProbe,
} from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";

import {
  CASE_LAW_SEARCH_FETCH_LIMIT,
  CASE_LAW_SEARCH_SIZES,
  caseLawSearchStatement,
  seedCaseLawSearch,
  unboundedCaseLawSearchStatement,
} from "./case-law-search-fixture";
import {
  CASE_LAW_SCENARIOS,
  type CaseLawScenarioGeneration,
  describeServed,
  seedCorpusReadBudgets,
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
import { measureScheduledJobRun } from "./scheduled-run";
import { seedQueryPerf } from "./seed";
import { UNBOUNDED_FRESHNESS_STATEMENTS } from "./unbounded-freshness-fixture";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const CORPUS_PROFILE_TIMEOUT_MS = 300_000;

const log = (record: Record<string, unknown>) => {
  console.info(JSON.stringify(record));
};

const profileBudgets = (
  profile: (typeof READ_BUDGET_PROFILES)[keyof typeof READ_BUDGET_PROFILES],
) =>
  Object.entries(READ_BUDGET_PROFILES)
    .filter(([, owner]) => owner === profile)
    .map(([id]) => id)
    .toSorted();

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

test("corpus page markers still reflect pages within the execution guard", () => {
  const id = "statement.legislation.candidateRows";
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
  expect(
    budgetProblem("statement.documents.searchHits", {
      sharedBlocks: READ_BUDGETS["statement.documents.searchHits"].pages,
      executionTimeMs: 10_000,
    }),
  ).toBeUndefined();
});

describe.skipIf(!enabled)("read budgets on PostgreSQL", () => {
  test("global Case Law search enriches only its page at both corpus sizes", async () => {
    const budgetId = "statement.caseLaw.globalSearchHits";
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    const measurements: number[] = [];
    await withQueryPerfFixture({
      databaseUrl,
      profileId: "corpus",
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async (db, deadline) => {
        for (const rows of CASE_LAW_SEARCH_SIZES) {
          // db-await-in-loop: grow and measure each isolated corpus sequentially.
          await deadline.run(`case-law search corpus ${rows}`, async () => {
            await seedCaseLawSearch(db, rows);
            const good = await measureOwnerStatement({
              database: db,
              build: caseLawSearchStatement,
            });
            const bad = await measureOwnerStatement({
              database: db,
              build: unboundedCaseLawSearchStatement,
            });
            log({
              event: "read_budget_measurement",
              budgetId,
              rows,
              budgetPages: READ_BUDGETS[budgetId].pages,
              after: good.metrics,
              before: bad.metrics,
            });
            log({
              event: "read_budget_plan",
              budgetId,
              rows,
              plan: good.plan.Plan,
              formerPlan: bad.plan.Plan,
            });
            expect(good.plan.Plan["Actual Rows"]).toBe(
              CASE_LAW_SEARCH_FETCH_LIMIT,
            );
            expect(bad.plan.Plan["Actual Rows"]).toBe(
              CASE_LAW_SEARCH_FETCH_LIMIT,
            );
            expect(budgetProblem(budgetId, good.metrics)).toBeUndefined();
            expect(
              budgetViolations(bad.metrics, READ_BUDGETS[budgetId].pages).map(
                ({ kind }) => kind,
              ),
            ).toContain("shared-buffer-budget");
            // Same values and order, including snippets, identifiers and ranking.
            const before = executedRows(
              await db.execute(unboundedCaseLawSearchStatement()),
            );
            const after = executedRows(
              await db.execute(caseLawSearchStatement()),
            );
            expect(after).toEqual(before);
            expect(after).toHaveLength(CASE_LAW_SEARCH_FETCH_LIMIT);
            expect(Object.keys(after.at(0) ?? {}).toSorted()).toEqual(
              [
                "id",
                "case_number",
                "ecli",
                "case_number_type",
                "court",
                "country",
                "decision_date",
                "slug",
                "language",
                "language_group_key",
                "identifiers",
                "headline",
                "tier",
                "score",
                "updated_at",
              ].toSorted(),
            );
            measurements.push(good.metrics.sharedBlocks);
          });
        }
      },
    });
    expect(measurements).toHaveLength(CASE_LAW_SEARCH_SIZES.length);
    expect(
      scaleViolations({
        size: measurements.at(0) ?? panic("Missing small measurement"),
        double: measurements.at(1) ?? panic("Missing growth measurement"),
      }),
    ).toEqual([]);
    expect(profileBudgets("case-law")).toEqual([budgetId]);
  }, 420_000); // timeout: two corpus sizes, warm-cache measurements and mutation checks on an isolated database.

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
              await measureOwnerStatement({ database: db, build: entry.build }),
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
        }

        const runMetrics = async (
          jobId: string,
          task: string,
          served: ServedCaseLaw,
        ) => {
          await serveCaseLaw(db, served);
          const generation = describeServed(served);
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
