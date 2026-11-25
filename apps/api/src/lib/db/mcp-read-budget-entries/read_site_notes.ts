import type { ReadBudgetId } from "../read-budgets";

// One bounded read of one website's notes (at most 30) on the member's own
// index. The read-scaling scenario measures statements and response size
// beside a growing number of the member's notes for other websites.
export default [] as const satisfies readonly ReadBudgetId[];
