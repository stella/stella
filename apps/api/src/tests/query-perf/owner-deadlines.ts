import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import type { ReadBudgetId } from "@/api/lib/db/read-budgets";

/** The deadline each measured runtime owner applies, or no owner deadline. */
export const QUERY_PERF_OWNER_DEADLINES = {
  "scheduled.caseLaw.reportFreshness": undefined,
  "statement.legislation.candidateRows":
    PUBLIC_READ_STATEMENT_TIMEOUT_MS.search,
  "statement.documents.searchHits": undefined,
} as const satisfies Record<ReadBudgetId, number | undefined>;
