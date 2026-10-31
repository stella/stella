import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import type { Verdict } from "@stll/db-load-gate/health";

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
import { BACKFILL_CASE_LAW_PROVISION_STATE_TASK } from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { scanOccurrences } from "@/api/tests/query-plans/plan-walker";

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
  coverageRefreshWroteSummary,
  describeServed,
  EXPRESSION_ID_BACKFILL_SIZES,
  PROVISION_BACKFILL_SIZES,
  readCoverageRefreshState,
  seedCorpusReadBudgets,
  seedExpressionIdBackfillRows,
  seedProvisionBackfillRows,
  serveCaseLaw,
} from "./corpus-seed";
import { withQueryPerfFixture } from "./fixture";
import {
  budgetProblem,
  budgetViolations,
  measureOwnerStatement,
  measureQueryPerf,
  OVER_BUDGET_REMOVAL_BAND,
  scaleViolations,
  shapeViolations,
  sharedBlockSampleProblem,
} from "./measurement";
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
import { QUERY_PERF_PROFILES } from "./profiles";
import {
  corpusStatementRegistry,
  queryPerfRegistry,
  READ_BUDGET_PROFILES,
  SCHEDULED_JOB_MEASUREMENTS,
  type ScheduledJobScenario,
} from "./registry";
import { seedRequestReceiptScenario } from "./request-receipt-seed";
import {
  isTransactionControl,
  measureScheduledJobRun,
  measureScheduledStatementsInOrder,
  QUERY_PERF_ADMISSION,
  statementsForMeasurement,
} from "./scheduled-run";
import { seedQueryPerf } from "./seed";
import { QUERY_PERF_TABLE_SIZES } from "./table-sizes";
import { UNBOUNDED_FRESHNESS_STATEMENTS } from "./unbounded-freshness-fixture";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const CORPUS_PROFILE_TIMEOUT_MS = 300_000;
const describeScheduledScenario = (scenario: ScheduledJobScenario) =>
  scenario.type === "case-law"
    ? describeServed(scenario.served)
    : `receipts:${scenario.cohort}:${scenario.rows}`;

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
      sharedBlocks: READ_BUDGETS["statement.documents.searchHits"].pages,
      executionTimeMs: 10_000,
    }),
  ).toBeUndefined();
});

describe.skipIf(!enabled)("read budgets on PostgreSQL", () => {
  test("measuring the provision-state backfill preserves its fixture and fresh-run pages", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("DATABASE_URL required for query perf");
    await withQueryPerfFixture({
      databaseUrl,
      profileId: "corpus",
      timeoutMs: CORPUS_PROFILE_TIMEOUT_MS,
      run: async (db, _deadline, openClient) => {
        await seedCorpusReadBudgets(db);
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
  }, 420_000); // timeout: the corpus profile seeds about a million rows before the integration assertion.

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
              owner: budgetId,
              ownerDeadlineMs: QUERY_PERF_OWNER_DEADLINES[budgetId],
              profileId: "corpus",
            });
            const bad = await measureOwnerStatement({
              database: db,
              build: unboundedCaseLawSearchStatement,
              owner: budgetId,
              ownerDeadlineMs: QUERY_PERF_OWNER_DEADLINES[budgetId],
              profileId: "corpus",
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
            // Fixed text hits must not walk unrelated decisions before LIMIT.
            expect(
              good.planViolations.filter(
                ({ kind, node }) =>
                  kind === "large-scan" &&
                  node["Relation Name"] ===
                    getTableName(schema.caseLawDecisions),
              ),
            ).toEqual([]);
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
        }

        const runMetrics = async (
          jobId: string,
          task: string,
          scenario?: ScheduledJobScenario,
        ) => {
          if (scenario?.type === "case-law") {
            await serveCaseLaw(db, scenario.served);
          } else if (scenario !== undefined) {
            await seedRequestReceiptScenario(db, scenario);
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
            const run = await measureScheduledJobRun({
              database: db,
              openClient,
              jobId,
              task,
            });
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
            return run.metrics;
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
            const label = describeScheduledScenario(scenario.size);
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
              `run ${jobId} on ${describeScheduledScenario(twin)}`,
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
