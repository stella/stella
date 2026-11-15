import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 1000 },
  combinedPagesPerRun: 1000,
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 1000,
    reason:
      "Thirty pages per changed erasure or audit row cover the lease, outcome transitions and audit inserts with their indexes; the run retains the existing 1,000-page envelope.",
  },
  reason:
    "One 25-row batch includes the eligible-index claim, lease, mixed success/failure transitions and both audit writes. Rolled-back owner-role replays measured 685 and 732 shared buffers with 1,000 and 10,000 terminal rows; the 1,000-page cap allows 268 further pages for deeper primary/audit indexes while the partial due index excludes terminal history.",
} as const satisfies ReadBudget;
