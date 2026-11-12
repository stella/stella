import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { asc, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import type { Verdict } from "@stll/db-load-gate/health";

import { CASE_LAW_REPLAY_PENDING_INDEX } from "@/api/db/case-law-parsed-input-state";
import * as schema from "@/api/db/schema";
import { BACKGROUND_REPLAY_ARMS } from "@/api/handlers/case-law/ingestion/replay";
import { QUEUE_REQUEUE_OUTCOME } from "@/api/lib/bullmq-requeue";
import { executedRows } from "@/api/lib/db/executed-rows";
import { READ_BUDGETS, readBudgetPages } from "@/api/lib/db/read-budgets";
import { READ_COMMITTED_BEGIN } from "@/api/lib/db/read-committed-unit";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusProjectionOutstandingIntentProbe,
  corpusProjectionUnpublishedIntentProbe,
} from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { BACKFILL_CASE_LAW_PROVISION_STATE_TASK } from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
import { DATA_EXPORT_HANDOFF_PAGE_SIZE } from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  indexedAccessPaths,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

import {
  CASE_LAW_SCENARIOS,
  type CaseLawScenarioGeneration,
  coverageRefreshWroteSummary,
  describeServed,
  EXPRESSION_ID_BACKFILL_SIZES,
  LEGISLATION_CANDIDATE_COUNT,
  PROVISION_BACKFILL_SIZES,
  readCoverageRefreshState,
  seedExpressionIdBackfillRows,
  seedProvisionBackfillRows,
  serveCaseLaw,
} from "./corpus-seed";
import measureLegislationCandidates from "./corpus-statement-entries/statement.legislation.candidateRows";
import { dropSeededCorpus, withSeededCorpus } from "./corpus-template";
import { seedDataExportScenario } from "./data-export-seed";
import { withQueryPerfFixture } from "./fixture";
import {
  applyProductionStateStatistics,
  estimatedGenerationStates,
  PROJECTION_STATE_READS_PER_CANDIDATE,
  projectionStateRowsVisited,
} from "./legislation-candidate-plan";
import {
  budgetProblem,
  budgetViolations,
  explainOwnerStatement,
  measureOwnerStatement,
  measureQueryPerf,
  metricsFromPlan,
  OVER_BUDGET_REMOVAL_BAND,
  scaleViolations,
  scheduledJobBudgetProblems,
  shapeViolations,
  sharedBlockSampleProblem,
  writeScaleViolations,
} from "./measurement";
import { QUERY_PERF_PROFILES } from "./profiles";
import {
  CORPUS_STATEMENT_BUDGET_IDS,
  corpusStatementRegistry,
  queryPerfRegistry,
  READ_BUDGET_PROFILES,
  SCHEDULED_JOB_MEASUREMENTS,
  type ScheduledJobScenario,
} from "./registry";
import { seedRequestReceiptScenario } from "./request-receipt-seed";
import { withQueryPerfRollback } from "./rollback";
import {
  isTransactionControl,
  measureScheduledJobRun,
  measureScheduledStatementsInOrder,
  QUERY_PERF_ADMISSION,
  statementsForMeasurement,
} from "./scheduled-run";
import { seedQueryPerf } from "./seed";
import { applyPlannerSettings } from "./settings";
import { QUERY_PERF_TABLE_SIZES } from "./table-sizes";
import { UNBOUNDED_FRESHNESS_STATEMENTS } from "./unbounded-freshness-fixture";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const CORPUS_PROFILE_TIMEOUT_MS = 300_000;
const describeScheduledScenario = (scenario: ScheduledJobScenario) => {
  switch (scenario.type) {
    case "case-law":
      return describeServed(scenario.served);
    case "data-exports":
    case "request-receipts":
      return `${scenario.type}:${scenario.cohort}:${scenario.rows}`;
    default:
      scenario satisfies never;
      return panic("Unknown scheduled measurement scenario", scenario);
  }
};

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

/** The budgets the scheduled-job measurements own: each budgeted job's own. */
const scheduledJobBudgets = () =>
  [
    ...new Set(
      DECLARED_SCHEDULER_JOBS.flatMap((job) =>
        typeof job.reads === "object" ? [job.reads.budget] : [],
      ),
    ),
  ].toSorted();

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

const provisionBackfillFixtureBytes = async (database: GatedTestDb) => {
  const result = await database.execute(sql`SELECT jsonb_build_object(
    'decisions', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.id), '[]'::jsonb)
      FROM case_law_decisions row
      WHERE row.source_id = '01990000-00c3-7000-8000-000000000001'::uuid),
    'units', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.decision_id), '[]'::jsonb)
      FROM case_law_provision_extractions row
      JOIN case_law_decisions decision ON decision.id = row.decision_id
      WHERE decision.source_id = '01990000-00c3-7000-8000-000000000001'::uuid),
    'scopes', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.country, row.language), '[]'::jsonb)
      FROM case_law_provision_extraction_scopes row),
    'transitions', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.country, row.language, row.generation), '[]'::jsonb)
      FROM case_law_provision_scope_transitions row),
    'admission', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.key), '[]'::jsonb)
      FROM case_law_provision_admission row),
    'repairCursors', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.name), '[]'::jsonb)
      FROM case_law_provision_repair_cursors row),
    'checkpoint', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.name), '[]'::jsonb)
      FROM database_backfill_states row
      WHERE row.name = 'caseLaw.backfillProvisionState.minutely')
  )::text AS bytes`);
  const row = executedRows(result).at(0);
  if (
    typeof row !== "object" ||
    row === null ||
    !("bytes" in row) ||
    typeof row.bytes !== "string"
  ) {
    return panic("Provision backfill fixture snapshot is missing");
  }
  return row.bytes;
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

test("every transaction control form the capture maps is left out of measurement", () => {
  const forms = [
    "BEGIN",
    READ_COMMITTED_BEGIN,
    "START TRANSACTION",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT job_step",
    "RELEASE job_step",
    "RELEASE SAVEPOINT job_step",
    "ROLLBACK TO job_step",
    "ROLLBACK TO SAVEPOINT job_step",
  ];
  expect(forms.filter((text) => !isTransactionControl(text))).toEqual([]);
  expect(
    statementsForMeasurement(
      "fixture.transaction-control",
      forms.map((text) => ({ text, params: [] })),
    ),
  ).toEqual([]);
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
    for (const sharedBlocks of [readBudgetPages(id), readBudgetPages(id) + 1]) {
      expect(
        budgetProblem(id, { sharedBlocks, executionTimeMs: 10_001 }),
      ).toContain("execution time");
    }
  }
});

test("over-budget markers use hysteresis while unmarked budgets retain their edge", () => {
  const id = "statement.legislation.candidateRows";
  const budget = READ_BUDGETS[id].pages;
  expect(OVER_BUDGET_REMOVAL_BAND).toBe(0.15);
  const removalLine = budget * 0.85;
  expect(
    budgetProblem(id, {
      sharedBlocks: removalLine,
      executionTimeMs: 10_000,
    }),
  ).toContain("remove its overBudget marker");
  expect(
    budgetProblem(id, {
      sharedBlocks: removalLine + 1,
      executionTimeMs: 10_000,
    }),
  ).toBeUndefined();
  expect(
    budgetProblem(id, { sharedBlocks: budget, executionTimeMs: 10_000 }),
  ).toBeUndefined();
  expect(
    budgetProblem(id, { sharedBlocks: budget + 1, executionTimeMs: 10_000 }),
  ).toBeUndefined();
  expect(
    budgetProblem("statement.documents.searchHits", {
      sharedBlocks: readBudgetPages("statement.documents.searchHits"),
      executionTimeMs: 10_000,
    }),
  ).toBeUndefined();
});

// The corpus profile's statements and scheduled jobs are measured in separate
// tests, each judging its own part; together they own every corpus budget.
test("corpus statement and scheduled-job measurements own every corpus budget", () => {
  expect(
    [
      ...new Set([...CORPUS_STATEMENT_BUDGET_IDS, ...scheduledJobBudgets()]),
    ].toSorted(),
  ).toEqual(profileBudgets("corpus"));
});

describe.skipIf(!enabled)("read budgets on PostgreSQL", () => {
  afterAll(async () => {
    await dropSeededCorpus();
  }, 35_000); // timeout: dropping the seeded corpus removes its files, as the fixture teardown's own 35-second limit allows.

  test("measuring the provision-state backfill preserves its fixture and fresh-run pages", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    await withSeededCorpus({
      databaseUrl,
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async ({ db, openClient }) => {
        await seedProvisionBackfillRows(db, PROVISION_BACKFILL_SIZES.base);
        const before = await provisionBackfillFixtureBytes(db);
        const first = await measureScheduledJobRun({
          database: db,
          openClient,
          jobId: SCHEDULER_BACKFILL_IDS.provisionState,
          task: BACKFILL_CASE_LAW_PROVISION_STATE_TASK,
        });
        expect(await provisionBackfillFixtureBytes(db)).toBe(before);
        const second = await measureScheduledJobRun({
          database: db,
          openClient,
          jobId: SCHEDULER_BACKFILL_IDS.provisionState,
          task: BACKFILL_CASE_LAW_PROVISION_STATE_TASK,
        });
        const measuredPages = (run: typeof first) =>
          run.statements.filter(({ statement }) =>
            statement.startsWith(
              "SELECT id::text AS id FROM case_law_decisions",
            ),
          ).length;
        expect(measuredPages(second)).toBe(measuredPages(first));
      },
    });
  }, 420_000); // timeout: the first corpus test seeds about a million rows before the integration assertion.

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
            expect(
              sharedBlockSampleProblem(budgetId, good.samples),
            ).toBeUndefined();
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

  test("a fixture job measures reads against each statement's original state", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    await withQueryPerfFixture({
      databaseUrl,
      profileId: "corpus",
      run: async (db) => {
        await db.execute(sql`CREATE TABLE query_perf_pending_fixture (
          id integer PRIMARY KEY,
          status text NOT NULL
        )`);
        await db.execute(
          sql`INSERT INTO query_perf_pending_fixture (id, status)
              VALUES (1, 'pending'), (2, 'pending')`,
        );
        const statements = await measureScheduledStatementsInOrder({
          database: db,
          jobId: "scheduled.caseLaw.refreshCoverage",
          readBudgetId: "scheduled.caseLaw.refreshCoverage",
          captured: [
            {
              text: "SELECT id FROM query_perf_pending_fixture WHERE status = 'pending' ORDER BY id",
              params: [],
            },
            {
              text: "UPDATE query_perf_pending_fixture SET status = 'done' WHERE status = 'pending'",
              params: [],
            },
            {
              text: "SELECT id FROM query_perf_pending_fixture WHERE status = 'pending' ORDER BY id",
              params: [],
            },
          ],
        });
        expect(
          [statements.at(0), statements.at(2)].map(
            (statement) => statement?.actualRows,
          ),
        ).toEqual([2, 0]);
      },
    });
  });

  test("corpus statements stay within their budgets at production shape and unbounded reads are refused", async () => {
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
    await withSeededCorpus({
      databaseUrl,
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async ({ db, deadline, seed }) => {
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
            budgetPages: readBudgetPages(budgetId),
            ...result.metrics,
            perRow: result.metrics.sharedBlocks / entry.expectedRows,
          });
          log({
            event: "read_budget_plan",
            profileId: "corpus",
            budgetId,
            plan: result.plan.Plan,
          });
          note(sharedBlockSampleProblem(budgetId, result.samples));
          note(
            result.plan.Plan["Actual Rows"] === entry.expectedRows
              ? undefined
              : `${id}: ${String(result.plan.Plan["Actual Rows"])} rows, expected ${String(entry.expectedRows)}`,
          );
          note(budgetProblem(budgetId, result.metrics));
          for (const violation of result.planViolations) {
            note(violation.message);
          }
          if (budgetId === "statement.caseLaw.euCompletionPage") {
            const scans = scanOccurrences(result.plan.Plan).filter(
              ({ relation }) =>
                relation === "case_law_decisions" ||
                relation === "eu_completion_receipts" ||
                relation === "case_law_index_jobs",
            );
            note(
              scans.length > 0 &&
                scans.every(({ nodeType }) => nodeType.includes("Index"))
                ? undefined
                : `${budgetId}: completion relations must use index scans`,
            );
            for (const index of [
              "case_law_decisions_source_id_page_idx",
              "case_law_index_jobs_decision_idx",
            ]) {
              note(
                scans.some((scan) => scan.index === index)
                  ? undefined
                  : `${budgetId}: missing ${index}`,
              );
            }
            const rows = await db.transaction(
              async (tx) => await entry.read(tx),
            );
            note(
              rows.length === entry.expectedRows &&
                rows.every((row) => !row.eligible)
                ? undefined
                : `${budgetId}: expected 100 ineligible rows`,
            );
          }
          // Plan stability by construction: every arm of the probe is one
          // index read, never a scan whose cost rests on a row estimate.
          if (budgetId === "statement.caseLaw.backgroundReplayProbe") {
            const scans = scanOccurrences(result.plan.Plan).filter(
              ({ relation }) => relation === "case_law_decisions",
            );
            const orderedReads = indexedAccessPaths(
              result.plan.Plan,
              "case_law_decisions",
            ).filter(
              ({ accessKind, branches }) =>
                accessKind !== "bitmap" &&
                branches.every(
                  ({ indexName }) =>
                    indexName === CASE_LAW_REPLAY_PENDING_INDEX.name,
                ),
            );
            note(
              scans.length === BACKGROUND_REPLAY_ARMS.length &&
                orderedReads.length === scans.length
                ? undefined
                : `${budgetId}: each arm must read ${CASE_LAW_REPLAY_PENDING_INDEX.name} alone; scans: ${scans.map(({ nodeType, index }) => `${nodeType} ${String(index)}`).join(", ")}`,
            );
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
          unbounded > readBudgetPages("scheduled.caseLaw.reportFreshness")
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
    expect([...measured].toSorted()).toEqual(
      [...CORPUS_STATEMENT_BUDGET_IDS].toSorted(),
    );
  }, 420_000); // timeout: the first corpus test seeds about a million rows inside the test's own 300-second deadline.

  // The generation is a constant of the eligibility lookup, so the planner
  // may drive the semi-join from the states table. Whichever side it drives
  // from, only the candidates' own states may be read.
  test("legislation candidates read only their own projection states under production statistics", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    const outcomes = await withSeededCorpus({
      databaseUrl,
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async ({ db, deadline, seed }) => {
        const statement = measureLegislationCandidates(seed);
        const read = async (statistics: "analyzed" | "production") =>
          await deadline.run(
            `legislation candidates, ${statistics} statistics`,
            async () =>
              await withQueryPerfRollback(db, async (tx) => {
                await applyPlannerSettings(tx);
                if (statistics === "production") {
                  await applyProductionStateStatistics(tx);
                }
                const estimate = await estimatedGenerationStates(tx);
                const document = await explainOwnerStatement(
                  tx,
                  statement.build(tx),
                );
                return { statistics, estimate, document };
              }),
          );
        return [await read("analyzed"), await read("production")];
      },
    });
    for (const { statistics, estimate, document } of outcomes) {
      const visited = projectionStateRowsVisited(document.Plan);
      log({
        event: "legislation_candidate_states",
        statistics,
        estimatedGenerationStates: estimate,
        statesRowsVisited: visited,
        sharedBlocks: metricsFromPlan(document).sharedBlocks,
        executionTimeMs: document["Execution Time"],
      });
      expect(document.Plan["Actual Rows"]).toBe(LEGISLATION_CANDIDATE_COUNT);
      expect(visited).toBeLessThanOrEqual(
        LEGISLATION_CANDIDATE_COUNT * PROJECTION_STATE_READS_PER_CANDIDATE,
      );
    }
    // The production statistics must put the generation below one page of
    // candidates, or they would not tempt the planner to drive from states.
    expect(
      outcomes.find(({ statistics }) => statistics === "production")?.estimate,
    ).toBeLessThan(LEGISLATION_CANDIDATE_COUNT);
  }, 420_000); // timeout: the first corpus test seeds about a million rows inside the test's own 300-second deadline.

  test("scheduled jobs stay within their budgets at production shape", async () => {
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
    await withSeededCorpus({
      databaseUrl,
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async ({ db, deadline, openClient }) => {
        const runMetrics = async (
          jobId: string,
          task: string,
          scenario?: ScheduledJobScenario,
        ) => {
          switch (scenario?.type) {
            case undefined:
              break;
            case "case-law":
              await serveCaseLaw(db, scenario.served);
              break;
            case "data-exports":
              await seedDataExportScenario(db, scenario);
              break;
            case "request-receipts":
              await seedRequestReceiptScenario(db, scenario);
              break;
            default:
              scenario satisfies never;
              panic("Unknown scheduled measurement scenario", scenario);
          }
          const measurement =
            SCHEDULED_JOB_MEASUREMENTS[jobId] ??
            panic(`No measurement for ${jobId}`);
          const release =
            scenario?.type === "case-law"
              ? await measurement.prepare?.({
                  database: db,
                  served: scenario.served,
                  openClient,
                })
              : undefined;
          try {
            const generation =
              scenario === undefined
                ? "backfill-source"
                : describeScheduledScenario(scenario);
            let enqueued = 0;
            const exportLifecycle = async () =>
              await db
                .select({
                  id: schema.organizationDataExports.id,
                  status: schema.organizationDataExports.status,
                })
                .from(schema.organizationDataExports)
                .orderBy(asc(schema.organizationDataExports.id));
            const originalExportLifecycle =
              scenario?.type === "data-exports"
                ? await exportLifecycle()
                : null;
            const run = await measureScheduledJobRun({
              database: db,
              openClient,
              jobId,
              task,
              ...(scenario?.type === "data-exports"
                ? {
                    dataExportMaintenance: {
                      handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
                      enqueue: async () => {
                        enqueued += 1;
                        return QUEUE_REQUEUE_OUTCOME.REQUEUED;
                      },
                    },
                  }
                : {}),
            });
            if (scenario?.type === "data-exports") {
              const retained = await db.$count(schema.organizationDataExports);
              if (retained !== scenario.rows) {
                panic("Scheduled measurement consumed its export fixture", {
                  retained,
                  expected: scenario.rows,
                });
              }
              const lifecycleChanged =
                JSON.stringify(await exportLifecycle()) !==
                JSON.stringify(originalExportLifecycle);
              if (lifecycleChanged !== (scenario.cohort === "transitions")) {
                panic(
                  "Export measurement missed its transition path",
                  scenario,
                );
              }
              if (enqueued > 0 !== (scenario.cohort !== "quiet")) {
                panic("Export measurement missed its handoff path", scenario);
              }
            }
            if (scenario?.type === "request-receipts") {
              const retained = await db.$count(
                schema.requestIdempotencyReceipts,
              );
              if (
                scenario.cohort === "quiet"
                  ? retained !== scenario.rows
                  : retained >= scenario.rows
              ) {
                panic(
                  "Scheduled measurement did not apply its receipt retention scenario",
                  {
                    retained,
                    expected: scenario.rows,
                  },
                );
              }
              const deleted = run.statements.some(({ statement }) =>
                /^delete\s/iu.test(statement),
              );
              if (deleted !== (scenario.cohort !== "quiet")) {
                panic(
                  "Receipt task did not exercise the expected retention path",
                  scenario,
                );
              }
            }
            log({
              event: "read_budget_job_run",
              jobId,
              generation,
              ...run.metrics,
              readMetrics: run.readMetrics,
              writeMetrics: run.writeMetrics,
              writtenRows: run.writtenRows,
              statements: run.statements,
            });
            for (const violation of run.planViolations) {
              note(violation.message);
            }
            if (
              measurement.executed !== undefined &&
              !(await measurement.executed(db))
            ) {
              note(
                `${jobId} on ${generation} left no proof of its work; the budget measured only its bookkeeping`,
              );
            }
            return run;
          } finally {
            await release?.();
          }
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
          if (measurement.measure !== undefined) {
            const { measure } = measurement;
            // db-await-in-loop: every writing job measures its fixed batch at both independently seeded history sizes.
            const runs = await deadline.run(
              `measure ${jobId}`,
              async () => await measure(openClient),
            );
            for (const run of runs) {
              log({ event: "read_budget_job_run", jobId, ...run });
              for (const problem of scheduledJobBudgetProblems(budgetId, run)) {
                note(problem);
              }
            }
            const small =
              runs.at(0) ?? panic("Missing small writing-job measurement");
            const large =
              runs.at(1) ?? panic("Missing large writing-job measurement");
            for (const violation of [
              ...scaleViolations({
                size: small.readMetrics.sharedBlocks,
                double: large.readMetrics.sharedBlocks,
              }),
              ...writeScaleViolations({ size: small, double: large }),
            ]) {
              note(`${jobId}: ${violation}`);
            }
            continue;
          }
          const backfill = backfillFixture(jobId);
          if (backfill !== undefined) {
            const runs: Awaited<ReturnType<typeof runMetrics>>[] = [];
            for (const rows of [backfill.sizes.base, backfill.sizes.double]) {
              // db-await-in-loop: the source table grows before the second bounded run is measured.
              const result = await deadline.run(
                `run ${jobId} with ${String(rows)} source rows`,
                async () => {
                  await backfill.seed(db, rows);
                  const countResult = await db.execute(
                    jobId === SCHEDULER_BACKFILL_IDS.provisionState
                      ? sql`SELECT count(*)::int AS count FROM case_law_decisions
                          WHERE source_id = '01990000-00c3-7000-8000-000000000001'::uuid`
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
                  if (jobId === SCHEDULER_BACKFILL_IDS.provisionState) {
                    const firstPage =
                      await db.execute(sql`SELECT source_id::text AS source
                      FROM case_law_decisions ORDER BY id LIMIT 50`);
                    expect(executedRows(firstPage)).toEqual(
                      Array.from({ length: 50 }, () => ({
                        source: "01990000-00c3-7000-8000-000000000001",
                      })),
                    );
                  }
                  return await runMetrics(jobId, measurement.task);
                },
              );
              runs.push(result);
              for (const problem of scheduledJobBudgetProblems(
                budgetId,
                result,
              )) {
                note(problem);
              }
            }
            const size =
              runs.at(0) ?? panic("missing base backfill measurement");
            const double =
              runs.at(1) ?? panic("missing double backfill measurement");
            for (const violation of [
              ...scaleViolations({
                size: size.readMetrics.sharedBlocks,
                double: double.readMetrics.sharedBlocks,
              }),
              ...writeScaleViolations({ size, double }),
            ]) {
              note(`${jobId} on backfill source rows: ${violation}`);
            }
            continue;
          }
          for (const scenario of measurement.scenarios) {
            const label = describeScheduledScenario(scenario.size);
            // db-await-in-loop: scenarios move the served generations, so they run one at a time.
            const size = await deadline.run(
              `run ${jobId} on ${label}`,
              async () =>
                await runMetrics(jobId, measurement.task, scenario.size),
            );
            for (const problem of scheduledJobBudgetProblems(budgetId, size)) {
              note(problem);
            }
            const twin = scenario.double;
            if (twin === undefined) {
              continue;
            }
            // db-await-in-loop: the twin scenario moves the served generations after the first run finished.
            const double = await deadline.run(
              `run ${jobId} on ${describeScheduledScenario(twin)}`,
              async () => await runMetrics(jobId, measurement.task, twin),
            );
            for (const problem of scheduledJobBudgetProblems(
              budgetId,
              double,
            )) {
              note(problem);
            }
            for (const violation of [
              ...scaleViolations({
                size: size.readMetrics.sharedBlocks,
                double: double.readMetrics.sharedBlocks,
              }),
              ...writeScaleViolations({ size, double }),
            ]) {
              note(`${jobId} on ${label}: ${violation}`);
            }
          }
        }
      },
    });
    expect(problems).toEqual([]);
    expect([...measured].toSorted()).toEqual(scheduledJobBudgets());
  }, 420_000); // timeout: the first corpus test seeds about a million rows inside the test's own 300-second deadline.

  test("the coverage refresh measured in place leaves its fixture as found", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    await withSeededCorpus({
      databaseUrl,
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async ({ db, deadline, openClient }) => {
        // The coverage refresh writes. Measured twice in place, it must leave
        // the fixture exactly as found and take the same path both times.
        const coverageJob =
          DECLARED_SCHEDULER_JOBS.find(
            ({ id }) => id === SCHEDULER_BACKFILL_IDS.coverage,
          ) ?? panic("The coverage refresh is not declared");
        const coverageMeasurement =
          SCHEDULED_JOB_MEASUREMENTS[coverageJob.id] ??
          panic("The coverage refresh has no measurement");
        const measureCoverageInPlace = async (
          admission: Verdict = QUERY_PERF_ADMISSION,
        ) => {
          const served = CASE_LAW_SCENARIOS.quiet.size;
          await serveCaseLaw(db, served);
          const release = await coverageMeasurement.prepare?.({
            database: db,
            served,
            openClient,
          });
          try {
            const run = await measureScheduledJobRun({
              database: db,
              openClient,
              jobId: coverageJob.id,
              task: coverageMeasurement.task,
              admission,
            });
            return {
              ...run,
              computed: await coverageRefreshWroteSummary(db),
            };
          } finally {
            await release?.();
          }
        };
        const coverageShape = (
          run: Awaited<ReturnType<typeof measureCoverageInPlace>>,
        ) =>
          run.statements.map(({ statement, planViolations }) => ({
            statement,
            violations: planViolations.map(({ kind }) => kind),
          }));
        await deadline.run("measure the coverage refresh twice", async () => {
          const found = await readCoverageRefreshState(db);
          const first = await measureCoverageInPlace();
          expect(await readCoverageRefreshState(db)).toEqual(found);
          const second = await measureCoverageInPlace();
          expect(await readCoverageRefreshState(db)).toEqual(found);
          expect(first.computed).toBe(true);
          expect(second.computed).toBe(true);
          expect(coverageShape(first).length).toBeGreaterThan(0);
          expect(coverageShape(second)).toEqual(coverageShape(first));
          // The check above is what a busy-window hold would fail.
          const held = await measureCoverageInPlace({
            kind: "stop",
            signals: [],
          });
          expect(held.computed).toBe(false);
          expect(await readCoverageRefreshState(db)).toEqual(found);
        });
      },
    });
  }, 420_000); // timeout: the first corpus test seeds about a million rows inside the test's own 300-second deadline.
});
