import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  reads: { pages: 18_000 },
  combinedPagesPerRun: 18_000,
  writes: {
    pagesPerWrittenRow: 30,
    ceilingPagesPerRun: 18_000,
    reason:
      "Thirty pages per changed row cover bounded shard, cursor and retirement writes; the run retains the existing 18,000-page envelope.",
  },
  statementDeadlineMs: 30_000,
  runBudgetMs: 15 * 60 * 1000,
  reason:
    "At most 500 change-log discovery rows and retirement candidates combined per run, plus one fold of at most 256 queued touches, each a primary-key read, a sibling probe and at most two shard-key probes; month recounts persist a snapshot boundary so bounded retirement does not repeat the decision scan. A run stops between months after fifteen minutes, leaving the scheduler ceiling room for its current month, and every statement has a thirty-second database deadline.",
} as const satisfies ReadBudget;
