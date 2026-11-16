import type { ReadBudgetId } from "../read-budgets";

// One primary-key read of a document, its open version and its current
// locator. The read-scaling scenario measures statements and response size at
// both corpus sizes.
export default [] as const satisfies readonly ReadBudgetId[];
