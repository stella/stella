import type { SQLWrapper } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import { legislationCandidateRowsStatement } from "@/api/handlers/legislation/search";
import type {
  ReadBudgetId,
  ScheduledJobReadBudgetId,
} from "@/api/lib/db/read-budgets";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import { REPORT_CASE_LAW_FRESHNESS_TASK } from "@/api/lib/scheduler/tasks/case-law-freshness-report";
import { REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK } from "@/api/lib/scheduler/tasks/case-law-sitemap-shard-refresh";
import { buildDocumentSearchQueries } from "@/api/lib/search/pg-fts-search-query";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { CorpusReadBudgetSeed, ServedCaseLaw } from "./corpus-seed";
import {
  CASE_LAW_SCENARIOS,
  LEGISLATION_CANDIDATE_COUNT,
  LEGISLATION_GENERATION,
  seedSitemapReadBudget,
} from "./corpus-seed";
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
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

type ScheduledJobMeasurement = {
  prepare?: typeof seedSitemapReadBudget;
  task: string;
  scenarios: readonly { size: ServedCaseLaw; double?: ServedCaseLaw }[];
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
  "caseLaw.refreshSitemapShards.hourly": {
    task: REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK,
    prepare: seedSitemapReadBudget,
    scenarios: [CASE_LAW_SCENARIOS.quiet],
  },
  "caseLaw.reportFreshness.fiveMinute": {
    // Imported, not spelled: the gate's CI scope follows this module's imports.
    task: REPORT_CASE_LAW_FRESHNESS_TASK,
    scenarios: Object.values(CASE_LAW_SCENARIOS),
  },
};

type DeclaredJobReads = {
  id: string;
  task: string;
  reads: { budget: ScheduledJobReadBudgetId } | "load-governed" | "unmeasured";
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
  "scheduled.caseLaw.refreshSitemapShards": "corpus",
  "scheduled.caseLaw.reportFreshness": "corpus",
  "statement.caseLaw.coverageSources": "coverage",
  "statement.legislation.candidateRows": "corpus",
  "statement.documents.searchHits": "tenant",
} as const satisfies Record<ReadBudgetId, "corpus" | "tenant" | "coverage">;
