/**
 * When the citation-authority recompute should run again, given how the
 * attempt that just finished ended.
 *
 * Kept free of the runner's DB and env imports so the schedule can be
 * exercised on its own.
 */

export const RECOMPUTE_OUTCOME = {
  RECOMPUTED: "recomputed",
  SKIPPED: "skipped",
  FAILED: "failed",
  /** Nothing to rank: no citation has resolved to a target yet. */
  IDLE: "idle",
  /** A previous process recomputed recently; wait out the remainder. */
  FRESH: "fresh",
} as const;

export type RecomputeOutcome =
  (typeof RECOMPUTE_OUTCOME)[keyof typeof RECOMPUTE_OUTCOME];

type RecomputeDelayOptions = {
  outcome: RecomputeOutcome;
  /** Consecutive failures including this one; 0 for any other outcome. */
  consecutiveFailures: number;
  retryDelayMs: number;
  intervalMs: number;
  /**
   * For `fresh` only: how much of the interval the last committed
   * recompute has left. Clamped into [retryDelayMs, intervalMs].
   */
  freshRemainingMs?: number;
};

/**
 * A recompute rewrites the whole corpus in one statement, so a failing one is
 * not free: it burns its entire statement-timeout budget against the same
 * tables the ingest loops are writing, and then leaves the corpus exactly as
 * large as it found it. Retrying that on a flat short delay turns a recompute
 * the corpus has outgrown into a permanent load source, because nothing about
 * why it failed changes between two attempts minutes apart. The heavier the
 * statement, the more the failing schedule costs, which is backwards.
 *
 * So only a *skip* keeps the flat short retry: there the lock holder is doing
 * the work and may exit before committing, and its replacement should not
 * inherit a full interval's gap. A failure doubles its delay per consecutive
 * failure, capped at the normal interval, which is the cadence a recompute
 * that can no longer finish settles at. Any non-failure resets the doubling,
 * so a single blip costs one short retry, not a degraded schedule.
 */
export const nextRecomputeDelayMs = ({
  outcome,
  consecutiveFailures,
  retryDelayMs,
  intervalMs,
  freshRemainingMs = 0,
}: RecomputeDelayOptions): number => {
  switch (outcome) {
    case RECOMPUTE_OUTCOME.RECOMPUTED:
      return intervalMs;
    case RECOMPUTE_OUTCOME.SKIPPED:
      return retryDelayMs;
    case RECOMPUTE_OUTCOME.IDLE:
      return intervalMs;
    case RECOMPUTE_OUTCOME.FRESH:
      return Math.min(Math.max(freshRemainingMs, retryDelayMs), intervalMs);
    case RECOMPUTE_OUTCOME.FAILED:
      return Math.min(
        retryDelayMs * 2 ** Math.max(0, consecutiveFailures - 1),
        intervalMs,
      );
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
};
