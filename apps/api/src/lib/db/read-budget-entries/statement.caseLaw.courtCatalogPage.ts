import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 64,
  reason:
    "One page of a country's admitted courts: the source catalogue, then one index walk of the folded population counts per admitted source, each stopping at the page's size. Measured on a country of 3,000 courts held by three sources; a page reads no further into them than it returns.",
} as const satisfies ReadBudget;
