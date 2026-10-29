import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { READ_BUDGETS, type ReadBudgetId } from "@/api/lib/db/read-budgets";
import { CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";

/** The deadline each measured runtime owner applies, or no owner deadline. */
export const QUERY_PERF_OWNER_DEADLINES = {
  "statement.caseLaw.globalSearchHits": undefined,
  "scheduled.caseLaw.reportFreshness": undefined,
  "scheduled.caseLaw.refreshSitemapShards":
    READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"].statementDeadlineMs,
  "statement.caseLaw.coverageSources":
    CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
  "statement.legislation.candidateRows":
    PUBLIC_READ_STATEMENT_TIMEOUT_MS.search,
  "statement.documents.searchHits": undefined,
} as const satisfies Record<ReadBudgetId, number | undefined>;
