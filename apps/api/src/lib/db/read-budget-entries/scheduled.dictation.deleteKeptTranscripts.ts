import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 1000 },
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 4000,
    reason:
      "A run deletes the confirmed ids of its batch of at most 50 and backs off the refused ones by key; thirty pages per written row cover the heap and, for a backed-off row, the entries of the table's three indexes.",
  },
  reason:
    "One run reads at most 50 due ids through the due-time index and reads at most 101 overdue ids through the recorded-time index. Rows that are not yet due stay outside the claim's index range and recent rows outside the overdue range, so the measured batch reads the same pages beside 1,000 and 10,000 of them.",
} as const satisfies ReadBudget;
