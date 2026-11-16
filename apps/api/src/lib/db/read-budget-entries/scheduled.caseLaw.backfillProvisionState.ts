import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 13_200 },
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 300_000,
    reason:
      "A 200-unit measured run writes 10,000 state rows and touches about 242,000-249,000 write pages. 300,000 pages leaves roughly 20% headroom; the load governor remains the runtime brake.",
  },
  reason:
    "A governed run checks the shared backfill checkpoint and processes at most 200 bounded provision-state units; a completed pass reads only the checkpoint. 13,200 pages is the target for a run with pending units.",
  overBudget: {
    reason:
      "Typed measurement attributes the nested state inserts to writes, but the remaining primary-key lock reads measure about 26,900 pages at both fixture sizes, above the 13,200-page read target.",
  },
} as const satisfies ReadBudget;
