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
   * Whether reconciliation is running or last stopped with work behind it.
   * Read synchronously, so the reconciliation side must publish "running"
   * before its first await; anything weaker would let a tick that outlives
   * an idle window keep exposing the previous tick's drained answer.
   * Required rather than optional so a new call site must decide.
   */
  hasUnfinishedReconciliation: () => boolean;
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
      const pending = await countPending();
      // Read reconciliation after the count settles: a reconciliation tick
      // that starts while the count is in flight still lands in this
      // sample, so a slow count cannot certify a moment it did not see.
      const idle = pending === 0 && !hasUnfinishedReconciliation();
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
