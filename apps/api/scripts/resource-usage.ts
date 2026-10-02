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

export const BATCH_MEMORY = {
  within: "within",
  nearCap: "near-cap",
  over: "over",
} as const;

type BatchMemoryVerdict =
  | { type: typeof BATCH_MEMORY.within }
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
  if (peakMb < budgetMb * RSS_NEAR_CAP_RATIO) {
    return { type: BATCH_MEMORY.within };
  }
  // A workflow command: GitHub Actions turns the line into a warning
  // annotation, and the stable title finds every instance in a run.
  return {
    type: BATCH_MEMORY.nearCap,
    annotation:
      `::warning title=API test batch near its memory cap::${label} peaked ` +
      `at ${peakMb} MB of its ${budgetMb} MB budget ` +
      `(${Math.round((peakMb / budgetMb) * 100)}%); files: ${testFiles.join(", ")}`,
  };
};
