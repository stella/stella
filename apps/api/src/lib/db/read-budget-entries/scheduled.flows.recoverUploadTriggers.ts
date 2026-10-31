import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  // Dense 60k/120k dispatch: 615/618 pages; ceil(618 / 256) * 256 = 768 (24.3% headroom).
  pages: 768,
  reason:
    "One bounded census or dispatch phase, with related dimensions growing from 5,000 to 10,000 rows. The persisted cursor bounds each pass independently of recipient admission; the measured page maximum includes index and heap layout headroom.",
} as const satisfies ReadBudget;
