import type { ReadBudgetId } from "../read-budgets";

// Reads only the one website's notes (at most 30) under the member's
// collection lock, and counts the member's websites once when a first note
// lands; every change then writes by primary key.
export default [] as const satisfies readonly ReadBudgetId[];
