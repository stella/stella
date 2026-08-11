/**
 * The standing walk that keeps every reconcilable source honest.
 *
 * A crawl cursor only records where it got to, not what it saw, so a page it
 * dropped is gone for good. Where a publisher can be asked what it lists for a
 * slice independently of that cursor, the gap is recoverable — and recovering
 * it is not a one-off: a source drifts continuously, so the check has to be
 * continuous too. This loop is that check, one bounded unit of work per source
 * per turn, round-robin, forever.
 *
 * Round-robin rather than per-source loops: the unit costs publisher requests,
 * and a source with an unbounded backlog would otherwise crowd out one with a
 * single missing decision. Every source gets one turn before any gets a
 * second.
 *
 * Kept free of the runner's DB, env and process imports so the pacing, the
 * backoff and the summary handling can be exercised on their own.
 */

/** How a source answered its turn. */
export const RECONCILIATION_TURN = {
  /** A unit ran; its counters are folded into the window's tally. */
  WORKED: "worked",
  /** Nothing was due; the source is surveyed and settled for now. */
  IDLE: "idle",
  /** Another writer holds the source. Not an error; asked again next turn. */
  LEASED: "leased",
} as const;

export type ReconciliationTurn =
  (typeof RECONCILIATION_TURN)[keyof typeof RECONCILIATION_TURN];

/**
 * What one unit accomplished, in the terms the summary reports. A `Record`
 * over these names, so a counter cannot be added without deciding how the
 * window reports it.
 */
export type ReconciliationCounts = {
  /** Items the publisher listed across the unit. */
  listed: number;
  /** Distinct keyable identities; what a slice is measured against. */
  keyable: number;
  /** Listed items with nothing to key on; never held, never missing. */
  unidentifiable: number;
  /** Identities already held when the unit started. */
  heldBefore: number;
  written: number;
  parked: number;
  terminal: number;
  resolved: number;
  failed: number;
  /** Misses left for the next visit because the unit's budget ran out. */
  deferred: number;
};

export type ReconciliationTurnResult = {
  turn: ReconciliationTurn;
  /** Present only on a worked turn. */
  counts?: ReconciliationCounts | undefined;
};

/** One source the loop takes turns over. */
export type ReconciliationSource = {
  /** Adapter key; used only to name the source in logs. */
  adapterKey: string;
  runWorkUnit: () => Promise<ReconciliationTurnResult>;
};

export type ReconciliationSweepSummary = ReconciliationCounts & {
  /** Turns that ran a unit. */
  worked: number;
  /** Turns that found nothing due. */
  idle: number;
  /** Turns that found the source held by another writer. */
  leased: number;
  /** Turns that threw, wherever the throw came from. */
  errored: number;
  /**
   * The most recent throw, so an error rate has a cause beside it. Left raw:
   * the caller renders it, and it renders a tag rather than a message,
   * because a message can carry more than an operator asked to see.
   */
  lastError: unknown;
};

const emptySummary = (): ReconciliationSweepSummary => ({
  worked: 0,
  idle: 0,
  leased: 0,
  errored: 0,
  lastError: undefined,
  listed: 0,
  keyable: 0,
  unidentifiable: 0,
  heldBefore: 0,
  written: 0,
  parked: 0,
  terminal: 0,
  resolved: 0,
  failed: 0,
  deferred: 0,
});

/**
 * A window with no worked turn and no throw says nothing an operator can act
 * on; liveness is the daemon's own heartbeat.
 */
const summaryIsEmpty = ({
  errored,
  worked,
}: ReconciliationSweepSummary): boolean => worked === 0 && errored === 0;

const addCounts = (
  summary: ReconciliationSweepSummary,
  counts: ReconciliationCounts,
): void => {
  summary.listed += counts.listed;
  summary.keyable += counts.keyable;
  summary.unidentifiable += counts.unidentifiable;
  summary.heldBefore += counts.heldBefore;
  summary.written += counts.written;
  summary.parked += counts.parked;
  summary.terminal += counts.terminal;
  summary.resolved += counts.resolved;
  summary.failed += counts.failed;
  summary.deferred += counts.deferred;
};

export type ReconciliationLoopTiming = {
  /** Gap between two work units. The politeness contract with publishers. */
  unitDelayMs: number;
  /** First sleep once every source reports nothing to do. */
  idleSleepMs: number;
  /** Ceiling the idle sleep doubles towards, so a settled corpus is cheap. */
  idleSleepMaxMs: number;
  /** How often the tallies are emitted. */
  summaryIntervalMs: number;
  /** Ceiling the post-failure delay doubles towards. */
  failureBackoffMaxMs: number;
};

/**
 * Defaults for everything except the unit gap, which is deployment
 * configuration: the gap decides how hard external publishers are asked, and
 * these decide how cheaply the loop waits.
 */
export const RECONCILIATION_LOOP_TIMING = {
  idleSleepMs: 30_000,
  idleSleepMaxMs: 15 * 60_000,
  summaryIntervalMs: 5 * 60_000,
  failureBackoffMaxMs: 60_000,
} as const satisfies Omit<ReconciliationLoopTiming, "unitDelayMs">;

/**
 * The longest slice a pacing wait sleeps before re-checking the drain flag.
 * The idle ceiling is minutes; a SIGTERM must not wait it out.
 */
export const RECONCILIATION_CHECK_SLICE_MS = 1000;

export type ReconciliationLoopOptions = {
  /** The sources with the capability, in a stable order. */
  sources: readonly ReconciliationSource[];
  /** Stops the walk without abandoning the unit already in flight. */
  isDraining: () => boolean;
  now: () => number;
  /** Receives the periodic tallies; nothing is logged per unit. */
  report: (summary: ReconciliationSweepSummary) => void;
  sleep: (ms: number) => Promise<void>;
  timing: ReconciliationLoopTiming;
};

/**
 * Take turns over the sources until the process drains.
 *
 * Which sleep ends a turn is the whole of the pacing policy:
 *
 * - a worked turn is followed by `unitDelayMs`, whatever it produced. A unit
 *   that found nothing missing still listed a slice from a publisher; it does
 *   not earn a faster next turn.
 * - a turn where every source reported idle or leased doubles its sleep
 *   towards the idle ceiling, so a settled corpus stops asking the database
 *   every half second. Any worked turn resets it.
 * - a throw doubles its delay towards the failure ceiling. Errors never break
 *   the loop: a source the publisher keeps refusing parks its own items, and
 *   a database that is unreachable for everything backs off and comes back.
 */
export const runCaseLawReconciliationLoop = async ({
  isDraining,
  now,
  report,
  sleep,
  sources,
  timing,
}: ReconciliationLoopOptions): Promise<void> => {
  if (sources.length === 0) {
    return;
  }

  let summary = emptySummary();
  let summaryDueAt = now() + timing.summaryIntervalMs;
  let idleMs = timing.idleSleepMs;
  let consecutiveFailures = 0;
  let cursor = 0;

  const flushSummary = (): void => {
    if (!summaryIsEmpty(summary)) {
      report(summary);
    }
    summary = emptySummary();
    summaryDueAt = now() + timing.summaryIntervalMs;
  };

  // One turn per source before any source gets a second, tracked across
  // iterations: a rotation that restarted at zero would starve every source
  // after the first whenever the loop backed off mid-rotation.
  let workedThisRotation = 0;

  while (!isDraining()) {
    const source = sources[cursor % sources.length];
    const rotationEnds = cursor % sources.length === sources.length - 1;
    cursor += 1;

    let delayMs = timing.unitDelayMs;
    let worked = false;

    try {
      // oxlint-disable-next-line no-await-in-loop -- one bounded unit at a time is the point; the next turn only starts after this one is paced
      const result = await (source?.runWorkUnit() ??
        Promise.resolve({ turn: RECONCILIATION_TURN.IDLE }));
      switch (result.turn) {
        case RECONCILIATION_TURN.WORKED:
          summary.worked += 1;
          worked = true;
          if (result.counts !== undefined) {
            addCounts(summary, result.counts);
          }
          break;
        case RECONCILIATION_TURN.IDLE:
          summary.idle += 1;
          break;
        case RECONCILIATION_TURN.LEASED:
          summary.leased += 1;
          break;
        default:
          break;
      }
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      summary.errored += 1;
      summary.lastError = error;
      worked = true;
      delayMs = Math.min(
        timing.unitDelayMs * 2 ** consecutiveFailures,
        timing.failureBackoffMaxMs,
      );
    }

    workedThisRotation += worked ? 1 : 0;
    if (rotationEnds) {
      // Only a rotation in which no source had anything to do is idle: with a
      // per-turn test a single busy source would keep every other source
      // polling at the unit rate.
      if (workedThisRotation === 0) {
        delayMs = Math.max(delayMs, idleMs);
        idleMs = Math.min(idleMs * 2, timing.idleSleepMaxMs);
      } else {
        idleMs = timing.idleSleepMs;
      }
      workedThisRotation = 0;
    }

    if (now() >= summaryDueAt) {
      flushSummary();
    }

    // The pacing itself: throughput is this gap, so the loop is sequential by
    // design. Sliced so a drain request interrupts an idle ceiling of minutes
    // within a second; a gap under one slice sleeps once.
    let remainingMs = delayMs;
    while (remainingMs > 0 && !isDraining()) {
      const sliceMs = Math.min(remainingMs, RECONCILIATION_CHECK_SLICE_MS);
      // oxlint-disable-next-line no-await-in-loop -- sequential pacing wait, sliced only to re-check the drain flag
      await sleep(sliceMs);
      remainingMs -= sliceMs;
    }
  }

  // A deployment must not discard the window in hand: without this the
  // tallies of a process replaced mid-window are never reported at all.
  flushSummary();
};
