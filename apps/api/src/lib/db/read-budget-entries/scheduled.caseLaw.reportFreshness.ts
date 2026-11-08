import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 12_500,
  reason:
    "One walk of the serving generation's queue index, capped at CASE_LAW_FRESHNESS_SCAN_CAP + 1 entries with at most one heap page each (about 10,200 pages when every entry sits on its own heap page), plus the source ages, the serving generation and three single-row queue probes. The run reads the same pages whatever the generation's size.",
} as const satisfies ReadBudget;
