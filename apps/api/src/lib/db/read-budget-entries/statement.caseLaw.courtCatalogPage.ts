import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 64,
  reason:
    "One page of a country's admitted courts: the source catalogue, then one index walk of the folded population counts per admitted source, each stopping at the page's size. On a country of 3,000 courts held by three sources, a page of 100 reads 25 shared pages; it reads no further into them than it returns.",
} as const satisfies ReadBudget;
