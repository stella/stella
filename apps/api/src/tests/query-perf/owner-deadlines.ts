import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import type { ReadBudgetId } from "@/api/lib/db/read-budgets";
import { REQUEST_RECEIPT_RETENTION_STATEMENT_BUDGET_MS } from "@/api/lib/idempotency/request-receipts";
import { CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";

/** The deadline each measured runtime owner applies, or no owner deadline. */
export const QUERY_PERF_OWNER_DEADLINES = {
  "scheduled.caseLaw.reportFreshness": undefined,
  "scheduled.requests.sweepReceipts":
    REQUEST_RECEIPT_RETENTION_STATEMENT_BUDGET_MS,
  "statement.caseLaw.coverageSources":
    CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
  "statement.legislation.candidateRows":
    PUBLIC_READ_STATEMENT_TIMEOUT_MS.search,
  "statement.documents.searchHits": undefined,
} as const satisfies Record<ReadBudgetId, number | undefined>;
