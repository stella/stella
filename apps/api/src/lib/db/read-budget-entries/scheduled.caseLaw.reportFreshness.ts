import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 15_100 },
  reason:
    "One walk of the serving generation's queue index, capped at CASE_LAW_FRESHNESS_SCAN_CAP + 1 entries with at most one heap page each (about 10,200 pages when every entry sits on its own heap page), plus the source ages, the serving generation and three single-row queue probes. The unserved gauge adds, per served generation, two walks capped at CORPUS_PROJECTION_UNSERVED_COUNT_CAP + 1 rows, each row with its own heap page and a unique-index lookup of the row it joins (up to four levels and one heap page): about 1,212 pages per generation; with no unserved entity each walk is one index probe. A family serves at most its serving generation and its declared partial generations, because the flip moves a jurisdiction only to a declared partial generation: four in all (the two serving generations, case_law_v9 and case_law_v12), about 4,850 pages. The gauge test re-derives this whenever a partial generation is declared. The run reads the same pages whatever the generation's size.",
} as const satisfies ReadBudget;
