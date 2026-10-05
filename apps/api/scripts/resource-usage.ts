const BYTES_PER_MB = 1024 * 1024;

/** Normalize Bun subprocess resource usage for the test-runner budget. */
export const maxRssBytesToMb = (maxRssBytes: number): number =>
  Math.round(maxRssBytes / BYTES_PER_MB);

/**
 * A passing batch this close to its cap fails on the next small growth, often
 * in an unrelated pull request whose files land in the same batch; reporting it
 * while it still passes lets the batch be fixed before it starts failing.
 */
export const RSS_NEAR_CAP_RATIO = 0.9;

/**
 * The planner keeps a shared batch's estimate within 70% of its cap
 * (TEST_BATCH_RSS_HEADROOM_RATIO), and measured batch peaks above 1 GB stay
 * within about 5% of that estimate. A shared batch above this ratio was
 * planned from a stale or missing measurement; it surfaces while the batch
 * still has room, so the table is refreshed before the batch nears its cap.
 */
export const RSS_PLAN_DRIFT_RATIO = 0.8;

export const BATCH_MEMORY = {
  within: "within",
  planDrift: "plan-drift",
  nearCap: "near-cap",
  over: "over",
} as const;

type BatchMemoryVerdict =
  | { type: typeof BATCH_MEMORY.within }
  | { type: typeof BATCH_MEMORY.planDrift; annotation: string }
  | { type: typeof BATCH_MEMORY.nearCap; annotation: string }
  | { type: typeof BATCH_MEMORY.over; message: string };

type BatchMemoryOptions = {
  label: string;
  peakMb: number;
  budgetMb: number;
  testFiles: readonly string[];
};

/** Memory verdict for a batch whose tests passed. */
export const batchMemoryVerdict = ({
  label,
  peakMb,
  budgetMb,
  testFiles,
}: BatchMemoryOptions): BatchMemoryVerdict => {
  if (peakMb > budgetMb) {
    return {
      type: BATCH_MEMORY.over,
      message:
        `Test batch exceeded the ${budgetMb} MB peak-RSS ` +
        "budget. Find what grew (new fixtures held across files, " +
        "unclosed pools/servers, oversized in-memory corpora) or split " +
        "the offending files; raising the budget requires justification " +
        "in the PR description.",
    };
  }
  const percent = Math.round((peakMb / budgetMb) * 100);
  if (peakMb < budgetMb * RSS_NEAR_CAP_RATIO) {
    // A single file cannot be split, so only shared batches can drift.
    if (testFiles.length < 2 || peakMb < budgetMb * RSS_PLAN_DRIFT_RATIO) {
      return { type: BATCH_MEMORY.within };
    }
    return {
      type: BATCH_MEMORY.planDrift,
      annotation:
        `::warning title=API test batch above its memory plan::${label} ` +
        `peaked at ${peakMb} MB of its ${budgetMb} MB budget (${percent}%); ` +
        "refresh apps/api/scripts/test-peak-rss.json (docs/test-memory.md); " +
        `files: ${testFiles.join(", ")}`,
    };
  }
  // A workflow command: GitHub Actions turns the line into a warning
  // annotation, and the stable title finds every instance in a run.
  return {
    type: BATCH_MEMORY.nearCap,
    annotation:
      `::warning title=API test batch near its memory cap::${label} peaked ` +
      `at ${peakMb} MB of its ${budgetMb} MB budget ` +
      `(${percent}%); files: ${testFiles.join(", ")}`,
  };
};
