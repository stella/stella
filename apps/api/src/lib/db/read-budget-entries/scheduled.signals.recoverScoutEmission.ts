import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  // Dense 60k/120k dispatch: 451/468 pages; ceil(468 / 256) * 256 = 512.
  pages: 512,
  reason:
    "One bounded census or dispatch phase, with related dimensions growing from 5,000 to 10,000 rows. The persisted cursor bounds each pass independently of recipient admission; rounding the measured maximum leaves index and heap layout headroom.",
} as const satisfies ReadBudget;
