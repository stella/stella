import type { SQLWrapper } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import { legislationCandidateRowsStatement } from "@/api/handlers/legislation/search";
import type {
  ReadBudgetId,
  ScheduledJobReadBudgetId,
} from "@/api/lib/db/read-budgets";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { REFRESH_CASE_LAW_COVERAGE_TASK } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { REPORT_CASE_LAW_FRESHNESS_TASK } from "@/api/lib/scheduler/tasks/case-law-freshness-report";
import { REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK } from "@/api/lib/scheduler/tasks/case-law-sitemap-shard-refresh";
import { SWEEP_REQUEST_RECEIPTS_TASK } from "@/api/lib/scheduler/tasks/request-receipt-retention";
import { buildDocumentSearchQueries } from "@/api/lib/search/pg-fts-search-query";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { CorpusReadBudgetSeed, ServedCaseLaw } from "./corpus-seed";
import {
  CASE_LAW_SCENARIOS,
  coverageRefreshWroteSummary,
  isolateCoverageRefreshMeasurement,
  LEGISLATION_CANDIDATE_COUNT,
  LEGISLATION_GENERATION,
  seedSitemapReadBudget,
} from "./corpus-seed";
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
import type { RequestReceiptScenario } from "./request-receipt-seed";
import type { seedQueryPerf } from "./seed";

/** Tenant statements, measured as `stella` under row security per profile. */
export const queryPerfRegistry = (
  seed: Awaited<ReturnType<typeof seedQueryPerf>>,
) =>
  [
    {
      budgetId: "statement.documents.searchHits",
      query: buildDocumentSearchQueries(seed.searchInput).hitsQuery,
      expectedRows: Math.min(seed.searchMatchCount, seed.searchInput.limit + 1),
      ownerDeadlineMs:
        QUERY_PERF_OWNER_DEADLINES["statement.documents.searchHits"],
    },
  ] as const satisfies readonly {
    budgetId: ReadBudgetId;
    query: SQLWrapper;
    expectedRows: number;
    ownerDeadlineMs: number | undefined;
  }[];

/** Public corpus statements, measured on the corpus profile as its owner. */
export const corpusStatementRegistry = (seed: CorpusReadBudgetSeed) =>
  [
    {
      budgetId: "statement.legislation.candidateRows",
      build: (tx: TransactionOf<GatedTestDb>) =>
        // The fixture's transaction supplies the select surface the reader uses.
        legislationCandidateRowsStatement(
          asTestRaw<LegislationReadTransaction>(tx),
          {
            ids: seed.candidateIds,
            generation: LEGISLATION_GENERATION,
            body: { query: "smlouva", jurisdiction: "CZE" },
          },
        ),
      expectedRows: LEGISLATION_CANDIDATE_COUNT,
      ownerDeadlineMs:
        QUERY_PERF_OWNER_DEADLINES["statement.legislation.candidateRows"],
    },
  ] as const satisfies readonly {
    budgetId: ReadBudgetId;
    build: (tx: TransactionOf<GatedTestDb>) => SQLWrapper;
    expectedRows: number;
    ownerDeadlineMs: number | undefined;
  }[];

export type ScheduledJobScenario =
  { type: "case-law"; served: ServedCaseLaw } | RequestReceiptScenario;

type ScheduledJobMeasurement = {
  prepare?: typeof seedSitemapReadBudget;
  /**
   * Whether the run did the job's work, read before `prepare` restores the
   * fixture. A governed job the load governor held issues only its bookkeeping,
   * and its statements would pass a budget without measuring the work.
   */
  executed?: (database: GatedTestDb) => Promise<boolean>;
  task: string;
  scenarios: readonly {
    size: ScheduledJobScenario;
    double?: ScheduledJobScenario;
  }[];
};

/**
 * How each budgeted scheduled job is measured, keyed by the job's id: the
 * gate runs that job's registered task against every corpus scenario it can
 * meet, at one size and, where the scenario has one, at twice that size, and
 * judges it against the budget the job's own registration declares. A job
 * that declares a budget without an entry here fails the census
 * (`scheduledJobMeasurementViolations`), however many other jobs share it.
 */
export const SCHEDULED_JOB_MEASUREMENTS: Readonly<
  Record<string, ScheduledJobMeasurement>
> = {
  [SCHEDULER_BACKFILL_IDS.coverage]: {
    task: REFRESH_CASE_LAW_COVERAGE_TASK,
    prepare: isolateCoverageRefreshMeasurement,
    executed: coverageRefreshWroteSummary,
    scenarios: [CASE_LAW_SCENARIOS.quiet],
  },
  "caseLaw.refreshSitemapShards.hourly": {
    task: REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK,
    prepare: seedSitemapReadBudget,
    scenarios: [
      { size: { type: "case-law", served: CASE_LAW_SCENARIOS.quiet.size } },
    ],
  },
  "requests.sweepReceipts.hourly": {
    task: SWEEP_REQUEST_RECEIPTS_TASK,
    scenarios: (["expired", "quiet", "mixed"] as const).map((cohort) => ({
      size: { type: "request-receipts", rows: 60_000, cohort },
      double: { type: "request-receipts", rows: 120_000, cohort },
    })),
  },
  "caseLaw.reportFreshness.fiveMinute": {
    // Imported, not spelled: the gate's CI scope follows this module's imports.
    task: REPORT_CASE_LAW_FRESHNESS_TASK,
    scenarios: Object.values(CASE_LAW_SCENARIOS).map((scenario) => ({
      size: { type: "case-law", served: scenario.size },
      ...("double" in scenario
        ? { double: { type: "case-law" as const, served: scenario.double } }
        : {}),
    })),
  },
};

type DeclaredJobReads = {
  id: string;
  task: string;
  reads:
    | { budget: ScheduledJobReadBudgetId; governance?: "load-governed" }
    | "load-governed"
    | "unmeasured";
};

/**
 * Every job that declares a read budget has a measurement of its own, for its
 * own task, and every measurement belongs to such a job.
 */
export const scheduledJobMeasurementViolations = (
  jobs: readonly DeclaredJobReads[],
  measurements: Readonly<Record<string, ScheduledJobMeasurement>>,
): string[] => {
  const budgeted = jobs.filter(
    (job): job is DeclaredJobReads & { reads: { budget: string } } =>
      typeof job.reads === "object",
  );
  const declared = new Set(budgeted.map(({ id }) => id));
  return [
    ...budgeted.flatMap((job) => {
      const measurement = measurements[job.id];
      if (measurement === undefined) {
        return [
          `${job.id} declares ${job.reads.budget} but has no measurement keyed by its id`,
        ];
      }
      return measurement.task === job.task
        ? []
        : [
            `${job.id} runs ${job.task}, but its measurement runs ${measurement.task}`,
          ];
    }),
    ...Object.keys(measurements)
      .filter((id) => !declared.has(id))
      .map((id) => `${id} is measured but declares no read budget`),
  ];
};

/** Which profile measures each budget; every budget has exactly one. */
export const READ_BUDGET_PROFILES = {
  "scheduled.caseLaw.refreshCoverage": "corpus",
  "scheduled.caseLaw.refreshSitemapShards": "corpus",
  "scheduled.caseLaw.reportFreshness": "corpus",
  "scheduled.requests.sweepReceipts": "corpus",
  "statement.caseLaw.coverageSources": "coverage",
  "statement.legislation.candidateRows": "corpus",
  "statement.documents.searchHits": "tenant",
} as const satisfies Record<ReadBudgetId, "corpus" | "tenant" | "coverage">;
