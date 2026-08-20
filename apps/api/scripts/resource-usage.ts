const BYTES_PER_MB = 1024 * 1024;

/** Normalize Bun subprocess resource usage for the test-runner budget. */
export const maxRssBytesToMb = (maxRssBytes: number): number =>
  Math.round(maxRssBytes / BYTES_PER_MB);
