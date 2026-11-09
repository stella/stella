import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 150,
  reason:
    "A governed coverage refresh reads the source policy, computes the bounded coverage snapshot, and writes its summary and audit record. The production-shape corpus fixture measures 89 pages; 150 pages leaves more than 50% headroom for production-height indexes.",
  overBudget: {
    reason:
      "Coverage ranks every maintained source/court bucket before its top-N cut. At 6,000 courts the canonical population table remains above 150 pages despite zero decision-corpus reads; a bounded top-N court projection maintained by the population owner is the follow-up.",
  },
} as const satisfies ReadBudget;
