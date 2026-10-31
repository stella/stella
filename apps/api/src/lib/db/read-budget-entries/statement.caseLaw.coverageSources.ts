import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "statement",
  pages: 256,
  reason:
    "Four fixture sources: eight date endpoint seeks at eight pages each (64), ninety precomputed court rows at two pages each (180), and twelve pages for the twenty-row uncached court source and grouped pending-text read: 256 pages total. Rejected filing dates must cost no heap walk.",
} as const satisfies ReadBudget;
