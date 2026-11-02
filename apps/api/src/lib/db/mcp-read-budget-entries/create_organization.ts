import type { ReadBudgetId } from "../read-budgets";

// Account creation has no corpus search statement. Its primary-key receipt,
// account lock and bounded lifecycle writes are measured together by the
// organization-create read-scaling scenario at both history sizes.
export default [] as const satisfies readonly ReadBudgetId[];
