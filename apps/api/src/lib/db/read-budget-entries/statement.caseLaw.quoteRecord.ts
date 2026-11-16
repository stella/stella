import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 64,
  reason:
    "One decision by primary key, its source by primary key and its bounded identifier index range. 64 shared buffers allow index descent, visibility checks and TOAST access for the stored AST; independent of corpus cardinality.",
} as const satisfies ReadBudget;
