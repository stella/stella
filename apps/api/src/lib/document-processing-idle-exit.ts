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
  /**
   * Whether a reconciliation tick is running right now, read synchronously
   * so the sample can re-check it in the frame it decides in. The
   * reconciliation side must set this in the tick's synchronous prologue,
   * before its own first await.
   */
  isReconciliationInFlight: () => boolean;
  /**
   * How many reconciliation ticks have started, read synchronously and
   * incremented in the same prologue as the flag above. Snapshotting it
   * around the count is what catches a tick that both started and finished
   * inside that window, which leaves no other trace.
   */
  reconciliationGeneration: () => number;
  /** Consecutive empty samples required before exiting. */
  requiredIdleChecks: number;
  onIdleExit: () => void;
  onCheckFailure: (error: unknown) => void;
};

export type IdleExitTickOutcome = "checked" | "exit" | "skipped";

export const createIdleExitCheck = ({
  countPending,
  hasUnfinishedReconciliation,
  isReconciliationInFlight,
  onCheckFailure,
  onIdleExit,
  reconciliationGeneration,
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
      // fresh jobs wait, which a worker close does not drain.
      const unfinished = await hasUnfinishedReconciliation();
      const generation = reconciliationGeneration();
      const pending = await countPending();
      // The count is the one window a sample cannot watch, so the decision
      // is taken in the frame the count resumes it in: no await separates
      // the reads below from the exit call, and neither timers nor
      // microtasks interleave inside a frame, so no tick can begin during
      // the decision itself. That leaves the ticks that began before it,
      // and the four terms are what make those total. `pending` and
      // `unfinished` answer for the tick this sample waited on and the
      // work it left. `isReconciliationInFlight` catches a tick that
      // started inside the count and is still running, which the verdict
      // above predates. The generation catches the one that started and
      // finished inside the count, leaving neither a running flag nor a
      // verdict this sample ever read, having possibly enqueued after the
      // count snapshot; a moved generation is not proof of work, so this
      // sample is conservative and the next one reads that tick's own
      // verdict. Every term covers a case the others provably do not.
      const idle =
        pending === 0 &&
        !unfinished &&
        !isReconciliationInFlight() &&
        reconciliationGeneration() === generation;
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
