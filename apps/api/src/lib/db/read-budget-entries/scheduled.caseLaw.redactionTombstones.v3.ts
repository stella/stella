import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 12_000 },
  combinedPagesPerRun: 12_000,
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 12_000,
    reason:
      "Thirty pages per cleared decision cover the indexed payload, pointer and search-row updates; the run retains the existing 12,000-page envelope.",
  },
  reason:
    "One 100-decision audit page, including durable pointer cleanup, search removal and inline publisher-payload cleanup. Measurements at 60,000 and 120,000 audited decisions stay below 9,100 shared pages; 12,000 leaves over 30% for deeper indexes and TOAST layout variation.",
} as const satisfies ReadBudget;
