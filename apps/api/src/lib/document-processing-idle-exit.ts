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

/**
 * How many times one sample may re-measure after a reconciliation tick
 * crossed its readings. Reconciliation runs on a far slower cadence than a
 * count takes, so a drained system settles on the first re-measure; the
 * bound only exists so a pathological producer cannot spin a sample.
 */
const SAMPLE_CHASE_LIMIT = 3;

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

  /**
   * One measurement of every source of work, re-measured while a
   * reconciliation tick keeps crossing it.
   *
   * Reconciliation first, then the count: reconciliation produces queue
   * entries and never consumes them, so waiting for the tick in flight to
   * report before counting means everything it enqueued is already in the
   * count. Counting first would pair a pre-enqueue count with the same
   * tick's drained verdict and read idle while fresh jobs wait, which a
   * worker close does not drain.
   *
   * The count is the one window a measurement cannot watch, so the verdict
   * is taken in the frame the count resumes it in: no await separates the
   * reads below from each other, and neither timers nor microtasks
   * interleave inside a frame, so no tick can begin during the decision
   * itself. That leaves ticks that began before it, and the reads are
   * total over them. `pending` and `unfinished` answer for the tick this
   * measurement waited on and the work it left. `isReconciliationInFlight`
   * catches a tick that started inside the count and is still running,
   * which the verdict above predates. The generation catches the one that
   * started and finished inside the count, leaving neither a running flag
   * nor a verdict this measurement ever read, and possibly enqueueing
   * after the count was taken.
   *
   * Neither of those last two means work exists; they mean this
   * measurement is not finished yet, so it measures again rather than
   * declaring the sample busy. Declaring it busy instead would livelock
   * exactly when the cadences line up: a tick that ends inside every
   * count would reset the streak forever on a system that is drained.
   * Re-measuring resolves it, because the next pass awaits that tick's own
   * verdict.
   */
  const measureIdle = async (chasesLeft: number): Promise<boolean> => {
    const unfinished = await hasUnfinishedReconciliation();
    const generation = reconciliationGeneration();
    const pending = await countPending();
    if (unfinished || pending > 0) {
      return false;
    }
    if (
      !isReconciliationInFlight() &&
      reconciliationGeneration() === generation
    ) {
      return true;
    }
    if (chasesLeft === 0) {
      // A producer that keeps starting ticks is not something to certify
      // as idle, however drained each one claims to be.
      return false;
    }
    return await measureIdle(chasesLeft - 1);
  };

  return async () => {
    // A slow count must not overlap the next tick: reordered completions
    // could stitch two stale empty samples across a busy interval and
    // exit before the queue was continuously idle.
    if (inFlight || exited) {
      return "skipped";
    }
    inFlight = true;
    try {
      const idle = await measureIdle(SAMPLE_CHASE_LIMIT);
      // The verdict was taken in the frame its own reads shared. Only
      // microtask resumptions separate it from this update and the exit
      // below, and a timer cannot interleave those, so the timer-driven
      // reconciliation loop cannot slip a tick in between.
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
