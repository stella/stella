import type { SQLWrapper } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import { legislationCandidateRowsStatement } from "@/api/handlers/legislation/search";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import type {
  ReadBudgetId,
  ScheduledJobReadBudgetId,
} from "@/api/lib/read-budgets";
import { REPORT_CASE_LAW_FRESHNESS_TASK } from "@/api/lib/scheduler/tasks/case-law-freshness-report";
import { buildDocumentSearchQueries } from "@/api/lib/search/pg-fts-search-query";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type {
  CaseLawScenarioGeneration,
  CorpusReadBudgetSeed,
} from "./corpus-seed";
import {
  CASE_LAW_SCENARIOS,
  LEGISLATION_CANDIDATE_COUNT,
  LEGISLATION_GENERATION,
} from "./corpus-seed";
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
    },
  ] as const satisfies readonly {
    budgetId: ReadBudgetId;
    query: SQLWrapper;
    expectedRows: number;
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
    },
  ] as const satisfies readonly {
    budgetId: ReadBudgetId;
    build: (tx: TransactionOf<GatedTestDb>) => SQLWrapper;
    expectedRows: number;
  }[];

/**
 * Scheduled jobs measured per run, each against every corpus scenario it can
 * meet, at one size and at twice that size.
 */
export const SCHEDULED_JOB_MEASUREMENTS = [
  {
    budgetId: "scheduled.caseLaw.reportFreshness",
    jobId: "caseLaw.reportFreshness.fiveMinute",
    // Imported, not spelled: the gate's CI scope follows this module's imports.
    task: REPORT_CASE_LAW_FRESHNESS_TASK,
    scenarios: Object.values(CASE_LAW_SCENARIOS),
  },
] as const satisfies readonly {
  budgetId: ScheduledJobReadBudgetId;
  jobId: string;
  task: string;
  scenarios: readonly {
    size: CaseLawScenarioGeneration;
    double: CaseLawScenarioGeneration;
  }[];
}[];

/** Which profile measures each budget; every budget has exactly one. */
export const READ_BUDGET_PROFILES = {
  "scheduled.caseLaw.reportFreshness": "corpus",
  "statement.legislation.candidateRows": "corpus",
  "statement.documents.searchHits": "tenant",
} as const satisfies Record<ReadBudgetId, "corpus" | "tenant">;
