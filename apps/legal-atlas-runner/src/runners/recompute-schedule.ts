/**
 * How long the citation-authority sweep waits before its next batch, given how
 * the batch that just finished ended.
 *
 * The sweep is continuous rather than periodic: it takes bounded batches of
 * the least recently computed decisions, and a batch that finds none is what
 * "the corpus is current" looks like. So the schedule has two regimes rather
 * than a single interval — a duty cycle while there is work, and a poll while
 * there is not.
 *
 * Kept free of the runner's DB and env imports so the schedule can be
 * exercised on its own.
 */

import { panic } from "better-result";

export const RECOMPUTE_OUTCOME = {
  /** A batch recomputed decisions. */
  ADVANCED: "advanced",
  /** Nothing was due: every decision is current within the refresh interval. */
  CURRENT: "current",
  /** Another process holds the sweep. Not an error; asked again next turn. */
  SKIPPED: "skipped",
  /** Nothing to rank: no citation has resolved to a target yet. */
  IDLE: "idle",
  FAILED: "failed",
} as const;

export type RecomputeOutcome =
  (typeof RECOMPUTE_OUTCOME)[keyof typeof RECOMPUTE_OUTCOME];

type RecomputeDelayOptions = {
  outcome: RecomputeOutcome;
  /** Consecutive failures including this one; 0 for any other outcome. */
  consecutiveFailures: number;
  /**
   * Gap between two batches while there is work. The whole throughput of the
   * sweep, and the knob that decides how much of the database it takes.
   */
  batchDelayMs: number;
  /** Poll gap once the corpus is current, and the ceiling on any backoff. */
  idleDelayMs: number;
};

/**
 * A batch is bounded, so a failing one no longer burns a whole-corpus
 * statement-timeout budget the way the single UPDATE did. It is still not
 * free: it fails against the same tables the ingest loops are writing, and
 * nothing about why it failed changes between two attempts seconds apart. So a
 * failure doubles its delay per consecutive failure up to the idle poll, which
 * is the cadence a sweep that can no longer finish settles at, and any
 * non-failure resets the doubling so a single blip costs one short retry
 * rather than a degraded schedule.
 *
 * A skip keeps the batch gap rather than backing off: the lock holder is doing
 * the work, and this process finding it held says nothing about how much work
 * is left.
 */
export const nextRecomputeDelayMs = ({
  outcome,
  consecutiveFailures,
  batchDelayMs,
  idleDelayMs,
}: RecomputeDelayOptions): number => {
  switch (outcome) {
    case RECOMPUTE_OUTCOME.ADVANCED:
      return batchDelayMs;
    case RECOMPUTE_OUTCOME.SKIPPED:
      return batchDelayMs;
    case RECOMPUTE_OUTCOME.CURRENT:
      return idleDelayMs;
    case RECOMPUTE_OUTCOME.IDLE:
      return idleDelayMs;
    case RECOMPUTE_OUTCOME.FAILED:
      return Math.min(
        batchDelayMs * 2 ** Math.max(0, consecutiveFailures - 1),
        idleDelayMs,
      );
    default: {
      outcome satisfies never;
      return panic(`Unhandled outcome: ${String(outcome)}`);
    }
  }
};
