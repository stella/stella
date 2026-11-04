import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 768,
  reason:
    "One page of a country's admitted courts from the live population: the bounded 16,384-delta window every live population read includes, plus the folded court rows of one country after the cursor, grouped and cut to the page. Measured on a country of 3,000 courts held by three sources.",
} as const satisfies ReadBudget;
