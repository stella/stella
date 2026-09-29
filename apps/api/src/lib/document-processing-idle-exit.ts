import { panic, Result } from "better-result";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { withTimeout } from "@/api/lib/with-timeout";

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
 *
 * That strict rule has one backstop, the quiet cap: a worker whose queue
 * has not shown a single pending job for `maxQuietChecks` samples exits
 * even while reconciliation still reports work. Every reconciliation
 * phase keeps its progress durably (database rows, the repair cursor) and
 * everything it enqueued stays in the durable queue, so exiting then only
 * defers that work to the next scheduled start. Without the cap, a phase
 * that never settles, a tick that hangs, or a store that stops answering
 * would keep the batch task billing forever.
 */

export const IDLE_EXIT_REASON = {
  /** Every source of work stayed empty for the whole window. */
  IDLE: "idle",
  /** The queue stayed quiet for the cap while reconciliation held on. */
  QUIET_CAP: "quiet_cap",
} as const;

export type IdleExitReason =
  (typeof IDLE_EXIT_REASON)[keyof typeof IDLE_EXIT_REASON];

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
  /**
   * Consecutive quiet samples after which the worker exits even though
   * reconciliation still holds it: see the quiet cap above. A quiet sample
   * is any completed one that did not see a pending job, so a count that
   * failed or timed out is quiet too; only a positive count resets it. At
   * least `requiredIdleChecks`, or the strict path could never be reached.
   */
  maxQuietChecks: number;
  /**
   * Deadline for each read a sample awaits. A count that misses it is a
   * failed sample, like any other failed count. A reconciliation wait that
   * misses it means a tick is still running, which is "not finished" and
   * not a failure. Without it, one hung read would keep the sample in
   * flight forever and every later tick would be skipped without a trace.
   */
  sampleTimeoutMs: number;
  onIdleExit: (reason: IdleExitReason) => void;
  onCheckFailure: (error: unknown) => void;
  /**
   * Fires once per process, on the sample where the quiet streak reaches
   * `requiredIdleChecks` while the strict streak has not: the moment the
   * worker would have exited had only the queue counted. The caller logs
   * what reconciliation is holding it for.
   */
  onReconciliationHold: () => void;
};

export type IdleExitTickOutcome = "checked" | "exit" | "skipped";

/**
 * What one completed sample saw. `pending` is the only verdict that breaks
 * the quiet streak, and `idle` the only one that extends the strict one.
 */
const SAMPLE_VERDICT = {
  FAILED: "failed",
  IDLE: "idle",
  PENDING: "pending",
  RECONCILING: "reconciling",
} as const;

type SampleVerdict = (typeof SAMPLE_VERDICT)[keyof typeof SAMPLE_VERDICT];

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
  maxQuietChecks,
  onCheckFailure,
  onIdleExit,
  onReconciliationHold,
  reconciliationGeneration,
  requiredIdleChecks,
  sampleTimeoutMs,
}: CreateIdleExitCheckOptions): (() => Promise<IdleExitTickOutcome>) => {
  if (maxQuietChecks < requiredIdleChecks) {
    panic(
      `maxQuietChecks (${maxQuietChecks}) is below requiredIdleChecks (${requiredIdleChecks})`,
    );
  }
  let consecutiveIdleChecks = 0;
  let consecutiveQuietChecks = 0;
  let holdReported = false;
  let inFlight = false;
  let exited = false;

  /**
   * The reconciliation verdict under the sample deadline. A tick that
   * outlasts it is running, so the verdict is "unfinished": the same
   * answer a sample gets from a tick that reports work left behind, which
   * keeps the strict streak honest while the quiet streak still grows.
   * Any other rejection is a failed sample, as before.
   */
  const reconciliationUnfinished = async (): Promise<boolean> => {
    const verdict = await Result.tryPromise({
      try: async () =>
        await withTimeout(async () => await hasUnfinishedReconciliation(), {
          label: "document processing idle sample reconciliation wait",
          timeoutMs: sampleTimeoutMs,
        }),
      catch: (cause) => cause,
    });
    if (Result.isOk(verdict)) {
      return verdict.value;
    }
    if (TimeoutError.is(verdict.error)) {
      return true;
    }
    throw verdict.error;
  };

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
   * itself. The count's deadline does not change that: it settles the
   * count through microtasks alone, which a timer cannot interleave. That
   * leaves ticks that began before it, and the reads are total over them.
   * `pending` and `unfinished` answer for the tick this measurement waited
   * on and the work it left. `isReconciliationInFlight` catches a tick
   * that started inside the count and is still running, which the verdict
   * above predates. The generation catches the one that started and
   * finished inside the count, leaving neither a running flag nor a
   * verdict this measurement ever read, and possibly enqueueing after the
   * count was taken.
   *
   * Neither of those last two means work exists; they mean this
   * measurement is not finished yet, so it measures again rather than
   * declaring the sample busy. Declaring it busy instead would livelock
   * exactly when the cadences line up: a tick that ends inside every
   * count would reset the streak forever on a system that is drained.
   * Re-measuring resolves it, because the next pass awaits that tick's own
   * verdict.
   */
  const measureIdle = async (chasesLeft: number): Promise<SampleVerdict> => {
    const unfinished = await reconciliationUnfinished();
    const generation = reconciliationGeneration();
    const pending = await withTimeout(async () => await countPending(), {
      label: "document processing idle sample count",
      timeoutMs: sampleTimeoutMs,
    });
    if (pending > 0) {
      return SAMPLE_VERDICT.PENDING;
    }
    if (unfinished) {
      return SAMPLE_VERDICT.RECONCILING;
    }
    if (
      !isReconciliationInFlight() &&
      reconciliationGeneration() === generation
    ) {
      return SAMPLE_VERDICT.IDLE;
    }
    if (chasesLeft === 0) {
      // A producer that keeps starting ticks is not something to certify
      // as idle, however drained each one claims to be.
      return SAMPLE_VERDICT.RECONCILING;
    }
    return await measureIdle(chasesLeft - 1);
  };

  const advanceStreaks = (verdict: SampleVerdict): void => {
    switch (verdict) {
      case SAMPLE_VERDICT.IDLE:
        consecutiveIdleChecks += 1;
        consecutiveQuietChecks += 1;
        return;
      case SAMPLE_VERDICT.FAILED:
      case SAMPLE_VERDICT.RECONCILING:
        consecutiveIdleChecks = 0;
        consecutiveQuietChecks += 1;
        return;
      case SAMPLE_VERDICT.PENDING:
        consecutiveIdleChecks = 0;
        consecutiveQuietChecks = 0;
        return;
      default:
        verdict satisfies never;
        panic(`Unhandled idle sample verdict: ${String(verdict)}`);
    }
  };

  const exit = (reason: IdleExitReason): IdleExitTickOutcome => {
    exited = true;
    onIdleExit(reason);
    return "exit";
  };

  return async () => {
    // A slow count must not overlap the next tick: reordered completions
    // could stitch two stale empty samples across a busy interval and
    // exit before the queue was continuously idle.
    if (inFlight || exited) {
      return "skipped";
    }
    inFlight = true;
    let verdict: SampleVerdict;
    try {
      verdict = await measureIdle(SAMPLE_CHASE_LIMIT);
    } catch (error) {
      onCheckFailure(error);
      verdict = SAMPLE_VERDICT.FAILED;
    } finally {
      inFlight = false;
    }
    // The verdict was taken in the frame its own reads shared. Only
    // microtask resumptions separate it from this update and the exit
    // below, and a timer cannot interleave those, so the timer-driven
    // reconciliation loop cannot slip a tick in between.
    advanceStreaks(verdict);
    if (consecutiveIdleChecks >= requiredIdleChecks) {
      return exit(IDLE_EXIT_REASON.IDLE);
    }
    if (!holdReported && consecutiveQuietChecks >= requiredIdleChecks) {
      holdReported = true;
      onReconciliationHold();
    }
    if (consecutiveQuietChecks >= maxQuietChecks) {
      return exit(IDLE_EXIT_REASON.QUIET_CAP);
    }
    return "checked";
  };
};
