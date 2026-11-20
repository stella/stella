import type { ReadBudget } from "../read-budget-definition";

// Approved 2026-11-20, set from measurement: the clean maximum over the
// repair, inline-raw and settled cohorts at 15,000 and 30,000 audited
// decisions, plus about ten percent.
export default {
  surface: "scheduled-job",
  reads: { pages: 5000 },
  combinedPagesPerRun: 23_500,
  writes: {
    pagesPerWrittenRow: 46,
    ceilingPagesPerRun: 23_000,
    reason:
      "A repaired decision measured at most 41.4 written pages per row: its desired erasure state in every active generation and its epoch, plus the payload, pointer and search-row clears. The inline publisher-payload clear alone measured 37.2 per row.",
  },
  reason:
    "One 50-decision audit page, including durable pointer cleanup, search removal, inline publisher-payload cleanup and the projection of each tombstone. Measured at most 21,326 combined and 20,732 written pages per run in the corpus profile, and 4,498 pages in the redaction profile, whose page total this read budget bounds.",
} as const satisfies ReadBudget;
