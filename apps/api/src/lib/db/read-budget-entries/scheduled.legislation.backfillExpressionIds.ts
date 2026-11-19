import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 1600 },
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 64,
    reason:
      "The measured bounded pass writes only its checkpoint rows, at 18 write pages per run; 64 pages leaves headroom for production-height indexes.",
  },
  reason:
    "A completed pass checks the shared backfill checkpoint and scans one bounded expression-id page. The production-shape corpus fixture measures 1,057 pages; 1,600 pages leaves 50% headroom for production-height indexes.",
} as const satisfies ReadBudget;
