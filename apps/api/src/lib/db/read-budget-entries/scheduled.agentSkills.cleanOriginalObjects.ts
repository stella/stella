import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 1000 },
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 2000,
    reason:
      "A run deletes the erased requests of its batch of at most 32 and backs off the failed ones by id; thirty pages per written row cover the heap and, for a backed-off row, the entries of the table's two indexes.",
  },
  reason:
    "One run reads at most 32 due requests through the due-time index. Requests that are not yet due stay outside the claim's index range, so the measured batch reads the same pages beside 1,000 and 10,000 of them.",
} as const satisfies ReadBudget;
