import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 6600,
  reason:
    "Rehydrates one page of 300 candidate ids: per candidate, the document by primary key twice (eligibility and the id-only join), one projection-state lookup, one revision lookup and one sibling probe, each about four to five pages deep on a production-sized index (22 pages per candidate).",
  overBudget: {
    reason:
      "Eligibility, the applied revision and the recurrence check each look up the same projection state; the state is read three times per candidate.",
  },
} as const satisfies ReadBudget;
