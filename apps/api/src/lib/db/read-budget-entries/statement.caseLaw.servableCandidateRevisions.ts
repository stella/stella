import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 5400,
  reason:
    "One scan round of an indexed case-law search, 300 candidate ids: per candidate, the decision by primary key, its source by primary key, the jurisdiction-serving pointer, and the projection state by primary key twice (admission and applied revision), each about three to five pages deep on a production-sized index (18 pages per candidate).",
} as const satisfies ReadBudget;
