import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 150,
  reason:
    "A governed coverage refresh reads the source policy, computes the bounded coverage snapshot, and writes its summary and audit record. The production-shape corpus fixture measures 89 pages; 150 pages leaves more than 50% headroom for production-height indexes.",
  overBudget: {
    reason:
      "Source ranking reads every court bucket before the top-N cut; per-source top-N court buckets materialized at facet refresh bring it under.",
  },
} as const satisfies ReadBudget;
