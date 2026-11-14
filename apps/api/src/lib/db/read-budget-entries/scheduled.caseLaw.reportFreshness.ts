import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 12_500 },
  reason:
    "One walk of the serving generation's queue index, capped at CASE_LAW_FRESHNESS_SCAN_CAP + 1 entries with at most one heap page each (about 10,200 pages when every entry sits on its own heap page), plus the source ages, the serving generation and three single-row queue probes. The unserved gauge adds, per served generation of either family, two walks of its partial indexes capped at CORPUS_PROJECTION_UNSERVED_COUNT_CAP + 1 rows, each row with at most one heap page and one primary-key lookup (about 600 pages per generation when every row sits on its own page); with no unserved entity each walk is one index probe. The run reads the same pages whatever the generation's size.",
} as const satisfies ReadBudget;
