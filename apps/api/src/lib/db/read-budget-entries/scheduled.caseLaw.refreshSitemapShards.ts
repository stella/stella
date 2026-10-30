import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 18_000,
  statementDeadlineMs: 30_000,
  runBudgetMs: 15 * 60 * 1000,
  reason:
    "One 500-row change-log window, one indexed country-month decision range, and the replacement shard rows per step. A run stops between months after fifteen minutes, leaving the scheduler ceiling room for its current month, and every statement has a thirty-second database deadline.",
} as const satisfies ReadBudget;
