import type { ReadBudgetId } from "@/api/lib/db/read-budgets";

import * as deadlines from "./deadline-entries/registry.gen";

/** The deadline each measured runtime owner applies, or no owner deadline. */
export const QUERY_PERF_OWNER_DEADLINES = deadlines satisfies Record<
  ReadBudgetId,
  number | undefined
>;
