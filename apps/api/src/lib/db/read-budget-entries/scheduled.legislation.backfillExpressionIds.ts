import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 1600,
  reason:
    "A completed pass checks the shared backfill checkpoint and scans one bounded expression-id page. The production-shape corpus fixture measures 1,057 pages; 1,600 pages leaves 50% headroom for production-height indexes.",
} as const satisfies ReadBudget;
