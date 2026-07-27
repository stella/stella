/**
 * How an ingestion cycle ended, and whether that counts as forward progress.
 *
 * Kept free of the runner's DB and env imports so the classification can be
 * exercised on its own.
 */

export const CYCLE_OUTCOME = {
  COMPLETED: "completed",
  FAILED: "failed",
  TIMEOUT: "timeout",
} as const;

export type CycleOutcome = (typeof CYCLE_OUTCOME)[keyof typeof CYCLE_OUTCOME];

export type CycleResult = {
  outcome: CycleOutcome;
  inserted: number;
  pagesProcessed: number;
};

/**
 * Forward progress is durable movement through the source, not how the cycle
 * ended and not how much it wrote.
 *
 * A cycle ends early whenever the pipeline sets a halt reason, and some halts
 * follow real work: a page whose corpus writes partly failed holds its cursor
 * and stops the cycle, but the pages before it advanced the cursor and their
 * rows were written. Classifying that as a stall both raises the
 * sustained-failure signal on a source that is ingesting normally and pins the
 * adapter to the failure backoff, throttling the very source that is keeping
 * up.
 *
 * `pagesProcessed` is the durable marker because the pipeline increments it
 * only after a page completes without halting, in the same step that advances
 * the cursor. `inserted` deliberately does NOT count: a corpus-write failure
 * preserves the row's previous source hash so the decision is reprocessed, so
 * a page parked on a persistent failure reports rows written on every retry
 * while the cursor never moves. Reading that as progress would reset the
 * streak and the backoff forever, silencing the alert on the one case it
 * exists to catch and hot-looping the adapter over a page it cannot pass.
 *
 * A "completed" cycle counts even with nothing to show for it: an adapter that
 * is caught up legitimately walks no pages and inserts nothing.
 */
export const cycleMadeProgress = ({
  outcome,
  pagesProcessed,
}: CycleResult): boolean =>
  outcome === CYCLE_OUTCOME.COMPLETED || pagesProcessed > 0;

/**
 * Whether a cycle is evidence the source is caught up, which drives the idle
 * (daily) polling cadence.
 *
 * Only a clean cycle that found nothing qualifies. A halt or a timeout means
 * the cycle stopped partway through a source that still has work, so it must
 * not read as quiet: an adapter already on the idle cadence would otherwise
 * stay there, taking a day per page.
 */
export const cycleWasIdle = ({ outcome, inserted }: CycleResult): boolean =>
  outcome === CYCLE_OUTCOME.COMPLETED && inserted === 0;
