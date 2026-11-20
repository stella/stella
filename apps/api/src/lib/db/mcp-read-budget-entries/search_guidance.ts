import type { ReadBudgetId } from "../read-budgets";

// One statement with no count, over a corpus without a query-perf fixture yet,
// so no buffer budget is declared. The read-scaling scenario holds its
// statements and response size at both corpus sizes.
export default [] as const satisfies readonly ReadBudgetId[];
