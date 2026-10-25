import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { READ_BUDGETS, type ReadBudgetId } from "@/api/lib/db/read-budgets";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusProjectionOutstandingIntentProbe,
  corpusProjectionUnpublishedIntentProbe,
} from "@/api/lib/legal-search/corpus-index-projection-convergence";

import {
  CASE_LAW_SCENARIOS,
  type CaseLawScenarioGeneration,
  seedCorpusReadBudgets,
  serveCaseLawGeneration,
} from "./corpus-seed";
import { withQueryPerfFixture } from "./fixture";
import {
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

const profileBudgets = (profile: "corpus" | "tenant") =>
  Object.entries(READ_BUDGET_PROFILES)
    .filter(([, owner]) => owner === profile)
    .map(([id]) => id)
    .toSorted();

/**
 * Why a measurement breaks its budget, if it does. An entry marked over
 * budget must stay over it: once a change brings it under, the marker has to
 * go, so the budget is enforced again.
 */
const budgetProblem = (
  id: ReadBudgetId,
  sharedBlocks: number,
): string | undefined => {
  const budget = READ_BUDGETS[id];
  const over =
    budgetViolations({ sharedBlocks, executionTimeMs: 0 }, budget.pages)
      .length > 0;
  if ("overBudget" in budget) {
    return over
      ? undefined
      : `${id} is marked over budget but measured ${String(sharedBlocks)} <= ${String(budget.pages)}; remove its overBudget marker`;
  }
  return over
    ? `${id}: ${String(sharedBlocks)} pages > budget ${String(budget.pages)}`
    : undefined;
};

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
            expect(budgetViolations(good.metrics, budget.pages)).toEqual([]);
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
          note(budgetProblem(budgetId, result.metrics.sharedBlocks));
        }

        const runPages = async (
          jobId: string,
          task: string,
          generation: CaseLawScenarioGeneration,
        ) => {
          await serveCaseLawGeneration(db, generation);
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
            pages: run.pages,
            statements: run.statements,
          });
          return run.pages;
        };
        for (const job of SCHEDULED_JOB_MEASUREMENTS) {
          const { budgetId } = job;
          measured.add(budgetId);
          for (const scenario of job.scenarios) {
            // db-await-in-loop: scenarios move the serving generation, so they run one at a time.
            const size = await deadline.run(
              `run ${job.jobId} on ${scenario.size}`,
              async () => await runPages(job.jobId, job.task, scenario.size),
            );
            // db-await-in-loop: the twin scenario moves the serving generation after the first run finished.
            const double = await deadline.run(
              `run ${job.jobId} on ${scenario.double}`,
              async () => await runPages(job.jobId, job.task, scenario.double),
            );
            note(budgetProblem(budgetId, size));
            note(budgetProblem(budgetId, double));
            for (const violation of scaleViolations({ size, double })) {
              note(`${job.jobId} on ${scenario.size}: ${violation}`);
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
            size: await revisionChecks(quiet.size),
            double: await revisionChecks(quiet.double),
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
