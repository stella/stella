/**
 * How an ingestion cycle ended, and whether that counts as forward progress.
 *
 * Kept free of the runner's DB and env imports so the classification can be
 * exercised on its own.
 */

export type CycleOutcome = "completed" | "failed" | "timeout";

export type CycleResult = {
  outcome: CycleOutcome;
  inserted: number;
  pagesProcessed: number;
};

/**
 * Forward progress is a property of the work a cycle did, not of how it
 * ended.
 *
 * A cycle ends early whenever the pipeline sets a halt reason, and some halts
 * follow real work: a page whose corpus writes partly failed holds its cursor
 * and stops the cycle, but the pages before it advanced the cursor and their
 * rows were written. Classifying that as a stall both raises the
 * sustained-failure signal on a source that is ingesting normally and pins the
 * adapter to the failure backoff, throttling the very source that is keeping
 * up.
 *
 * A "completed" cycle counts even with nothing to show for it: an adapter that
 * is caught up legitimately walks no pages and inserts nothing.
 */
export const cycleMadeProgress = ({
  outcome,
  inserted,
  pagesProcessed,
}: CycleResult): boolean =>
  outcome === "completed" || pagesProcessed > 0 || inserted > 0;
