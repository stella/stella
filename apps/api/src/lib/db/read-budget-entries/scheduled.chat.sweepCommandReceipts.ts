import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 1000 },
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 4000,
    reason:
      "Each batch deletes at most 500 expired receipts by key; thirty pages per deleted row cover the heap and the entries of its four indexes.",
  },
  reason:
    "Each batch takes at most 500 expired receipts through the acceptance-time index, reading their keys only. Receipts inside their retention stay outside the index range, so the measured 25-receipt batch reads the same pages beside 1,000 and 10,000 of them.",
} as const satisfies ReadBudget;
