import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { PROVISION_BACKFILL_STATEMENT_TIMEOUT_MS } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { ReadBudgetId } from "@/api/lib/db/read-budgets";
import { SCHEDULER_BACKFILL_CONFIG } from "@/api/lib/scheduler/backfill-config";
import { CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";

/** The deadline each measured runtime owner applies, or no owner deadline. */
export const QUERY_PERF_OWNER_DEADLINES = {
  "scheduled.caseLaw.backfillProvisionState":
    PROVISION_BACKFILL_STATEMENT_TIMEOUT_MS,
  "scheduled.caseLaw.refreshCoverage":
    CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
  "scheduled.caseLaw.reportFreshness": undefined,
  "scheduled.legislation.backfillExpressionIds":
    SCHEDULER_BACKFILL_CONFIG.batchStatementTimeoutMs,
  "statement.caseLaw.coverageSources":
    CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
  "statement.legislation.candidateRows":
    PUBLIC_READ_STATEMENT_TIMEOUT_MS.search,
  "statement.documents.searchHits": undefined,
} as const satisfies Record<ReadBudgetId, number | undefined>;
