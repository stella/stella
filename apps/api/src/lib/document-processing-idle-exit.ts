/**
 * Idle-exit decision core for the document-processing worker's batch
 * mode, separated from the timer so its concurrency rules are testable
 * tick by tick: only completed, non-overlapping samples advance the
 * streak, a failed count resets it (never exit on uncertainty), and the
 * exit callback fires exactly once.
 *
 * Idle means every source of work is empty, not just the job queue. The
 * reconciliation loop drains its own backlogs one capped batch per tick
 * without enqueueing jobs, so a worker that watched only queue depth
 * would exit mid-drain and strand the remainder until the next start.
 */

type CreateIdleExitCheckOptions = {
  countPending: () => Promise<number>;
  /**
   * Whether reconciliation left work behind, answered no earlier than the
   * tick that is running: the sample waits for a tick in flight instead of
   * racing it, so the answer never depends on how the sampling cadence
   * lines up with the reconciliation cadence, and never comes from the
   * tick before. Required rather than optional so a new call site must
   * decide.
   */
  hasUnfinishedReconciliation: () => Promise<boolean>;
  /** Consecutive empty samples required before exiting. */
  requiredIdleChecks: number;
  onIdleExit: () => void;
  onCheckFailure: (error: unknown) => void;
};

export type IdleExitTickOutcome = "checked" | "exit" | "skipped";

export const createIdleExitCheck = ({
  countPending,
  hasUnfinishedReconciliation,
  onCheckFailure,
  onIdleExit,
  requiredIdleChecks,
}: CreateIdleExitCheckOptions): (() => Promise<IdleExitTickOutcome>) => {
  let consecutiveIdleChecks = 0;
  let inFlight = false;
  let exited = false;

  return async () => {
    // A slow count must not overlap the next tick: reordered completions
    // could stitch two stale empty samples across a busy interval and
    // exit before the queue was continuously idle.
    if (inFlight || exited) {
      return "skipped";
    }
    inFlight = true;
    try {
      // Reconciliation first, then the count. Reconciliation produces
      // queue entries and never consumes them, so waiting for the tick in
      // flight to report before counting means everything it enqueued is
      // already in the count. Counting first would pair a pre-enqueue
      // count with the same tick's drained verdict and read idle while
      // fresh jobs wait, which a worker close does not drain. A tick that
      // starts after this verdict has already marked itself unfinished
      // before its own first await, so the next sample reads it as
      // running rather than reading its result.
      const unfinished = await hasUnfinishedReconciliation();
      const pending = await countPending();
      const idle = pending === 0 && !unfinished;
      consecutiveIdleChecks = idle ? consecutiveIdleChecks + 1 : 0;
    } catch (error) {
      onCheckFailure(error);
      consecutiveIdleChecks = 0;
    } finally {
      inFlight = false;
    }
    if (consecutiveIdleChecks < requiredIdleChecks) {
      return "checked";
    }
    exited = true;
    onIdleExit();
    return "exit";
  };
};
