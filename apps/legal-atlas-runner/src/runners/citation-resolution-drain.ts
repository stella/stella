/**
 * The standing walk that settles every citation the corpus holds.
 *
 * Resolution is not a migration that runs once. A citation whose key names a
 * decision nobody holds yet becomes resolvable the day that decision is
 * crawled, and a second decision under a key that had one holder retracts the
 * edge drawn to the first. Both put rows back in the pending queue from the
 * ingestion side, so the queue never permanently empties and the thing that
 * drains it has to be continuous.
 *
 * One bounded statement per turn, keyset-paced, with the cursor persisted so a
 * replacement task resumes where the last one stopped rather than re-reading
 * the index entries autovacuum has not reclaimed. A batch that comes back
 * empty wraps the cursor to the beginning, which is also what picks up rows an
 * arriving decision reopened behind it.
 *
 * The failure this exists to make visible is the quiet one: a queue with work
 * in it and a loop making no progress look identical in a log that only
 * records successes. So the window reports the pending gauge beside the
 * settled counts, and a run of windows where the first is non-zero and the
 * second is zero is reported as a contradiction rather than as silence.
 *
 * Kept free of the runner's DB, env and process imports so the pacing, the
 * cursor wrap and the contradiction escalation can be exercised on their own.
 */

import { panic } from "better-result";

import type { CitationResolutionCounts } from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_RULES,
  countsByRule,
} from "@/api/handlers/case-law/citation-resolution-status";
import { pgErrorFields } from "@/api/lib/pg-error";

/** How one turn ended. */
export const CITATION_RESOLUTION_STEP = {
  /** A batch examined rows; its counts fold into the window. */
  SETTLED: "settled",
  /** The batch found nothing left; the cursor wraps to the beginning. */
  DRAINED: "drained",
  /** Another writer holds the walk. Not an error; asked again next turn. */
  BUSY: "busy",
} as const;

export type CitationResolutionStepKind =
  (typeof CITATION_RESOLUTION_STEP)[keyof typeof CITATION_RESOLUTION_STEP];

export type CitationResolutionStep =
  | {
      type: typeof CITATION_RESOLUTION_STEP.SETTLED;
      counts: CitationResolutionCounts;
    }
  | { type: typeof CITATION_RESOLUTION_STEP.DRAINED }
  | { type: typeof CITATION_RESOLUTION_STEP.BUSY };

export type CitationResolutionDrainSummary = CitationResolutionCounts & {
  /** Turns that examined rows. */
  batches: number;
  /** Turns that found the queue empty from the cursor onwards. */
  drained: number;
  /** Turns that found the walk held by another writer. */
  busy: number;
  /** Turns that threw. */
  errored: number;
  /**
   * The most recent throw's structural tag. A tag rather than the error: a
   * message can carry more than an operator asked to see, and a summary that
   * never holds one cannot leak one.
   */
  lastErrorTag: string | undefined;
  /**
   * The most recent throw's Postgres SQLSTATE and schema identifiers, empty
   * when it was not a database error.
   *
   * The tag above names the wrapper: every failure raised inside a prepared
   * query arrives as `DrizzleQueryError`, so a wedged walk reports the same
   * tag whether the statement hit a missing column, a privilege, or a
   * constraint. These fields carry the part that distinguishes them, and
   * `pgErrorFields` selects only identifiers naming database objects, so the
   * no-message rule above still holds.
   */
  lastErrorPgFields: Record<string, string>;
  /**
   * Rows still waiting when the window closed, or null when the gauge could
   * not be read. The denominator every other number in the line is judged
   * against.
   */
  pending: number | null;
  /**
   * How many consecutive windows have had work waiting and settled nothing.
   * Null while that is not the case. This is the signal a log of successes
   * cannot carry: a wedged walk and an empty queue are otherwise the same
   * silence.
   */
  idleContradictionWindows: number | null;
};

export type CitationResolutionDrainTiming = {
  /**
   * Gap after a turn that settled rows. The whole duty cycle of the walk:
   * throughput is batch size divided by this, and the reason it is not zero is
   * that the database serving it is also serving readers.
   */
  batchDelayMs: number;
  /** First sleep once the queue is empty. */
  idleSleepMs: number;
  /** Ceiling the idle sleep doubles towards, so a settled corpus is cheap. */
  idleSleepMaxMs: number;
  /** How often the tallies and the gauge are emitted. */
  summaryIntervalMs: number;
  /**
   * Where the post-failure delay starts doubling from, independent of the duty
   * cycle. A backfill may legitimately set the batch gap to zero; deriving the
   * backoff from it would then make every failure delay zero, and a database
   * that is refusing statements would be asked again as fast as it can refuse.
   */
  failureBackoffMinMs: number;
  /** Ceiling the post-failure delay doubles towards. */
  failureBackoffMaxMs: number;
  /**
   * Consecutive contradicting windows before the condition is reported. Two,
   * because one window can straddle a deployment or a lock handoff.
   */
  idleContradictionWindows: number;
};

export const CITATION_RESOLUTION_DRAIN_TIMING = {
  idleSleepMs: 30_000,
  idleSleepMaxMs: 15 * 60_000,
  summaryIntervalMs: 5 * 60_000,
  failureBackoffMinMs: 1000,
  failureBackoffMaxMs: 60_000,
  idleContradictionWindows: 2,
} as const satisfies Omit<CitationResolutionDrainTiming, "batchDelayMs">;

/**
 * The longest slice a pacing wait sleeps before re-checking the drain flag.
 * The idle ceiling is minutes; a SIGTERM must not wait it out.
 */
export const CITATION_RESOLUTION_CHECK_SLICE_MS = 1000;

export type CitationResolutionDrainOptions = {
  /**
   * Settles one bounded batch, or reports the walk held.
   *
   * The position is not this loop's to carry: it is read and written inside
   * the same locked transaction as the batch, so two replicas cannot persist
   * out of order and a replica that finds the walk held cannot overwrite the
   * holder's position with a stale one.
   */
  settleBatch: () => Promise<CitationResolutionStep>;
  /** Rows still waiting. Read once per window, never per batch. */
  readPending: () => Promise<number>;
  /** Reduces an unknown throw to a structural tag. */
  errorTag: (error: unknown) => string;
  /** Stops the walk without abandoning the batch already in flight. */
  isDraining: () => boolean;
  now: () => number;
  /** Receives the periodic tallies; nothing is logged per batch. */
  report: (summary: CitationResolutionDrainSummary) => void;
  sleep: (ms: number) => Promise<void>;
  timing: CitationResolutionDrainTiming;
};

const emptySummary = (): CitationResolutionDrainSummary => ({
  scanned: 0,
  resolved: 0,
  resolvedByRule: countsByRule(() => 0),
  unmatched: 0,
  ambiguous: 0,
  jurisdictionBlocked: 0,
  undeclaredJurisdiction: 0,
  batches: 0,
  drained: 0,
  busy: 0,
  errored: 0,
  lastErrorTag: undefined,
  lastErrorPgFields: {},
  pending: null,
  idleContradictionWindows: null,
});

const addCounts = (
  summary: CitationResolutionDrainSummary,
  counts: CitationResolutionCounts,
): void => {
  summary.scanned += counts.scanned;
  summary.resolved += counts.resolved;
  for (const rule of CITATION_RESOLUTION_RULES) {
    summary.resolvedByRule[rule] += counts.resolvedByRule[rule];
  }
  summary.unmatched += counts.unmatched;
  summary.ambiguous += counts.ambiguous;
  summary.jurisdictionBlocked += counts.jurisdictionBlocked;
  summary.undeclaredJurisdiction += counts.undeclaredJurisdiction;
};

/**
 * A window that settled nothing while rows were waiting.
 *
 * `scanned` rather than `resolved` is the progress test on purpose: a batch
 * that examined rows and marked every one of them unmatched has made progress,
 * because those rows have left the queue. What this catches is a walk that
 * examines nothing at all while the queue is not empty — a lock nobody
 * releases, a cursor that cannot advance, a statement that keeps failing.
 */
const windowContradicts = (summary: CitationResolutionDrainSummary): boolean =>
  summary.pending !== null && summary.pending > 0 && summary.scanned === 0;

/**
 * Walk until the process drains.
 *
 * Which sleep ends a turn is the whole of the pacing policy:
 *
 * - a turn that settled rows is followed by the duty-cycle gap, whatever it
 *   found. Throughput is that gap, deliberately, because the database serving
 *   this walk is also serving readers.
 * - a turn that found the queue empty doubles its sleep towards the idle
 *   ceiling, so a settled corpus stops asking. Any settled turn resets it. The
 *   batch itself wraps the persisted position, so the next turn starts from
 *   the beginning and picks up whatever an arriving decision reopened behind
 *   it.
 * - a turn that threw backs off from its own floor towards the failure
 *   ceiling. Errors never break the walk.
 */
export const runCitationResolutionDrain = async ({
  errorTag,
  isDraining,
  now,
  readPending,
  report,
  settleBatch,
  sleep,
  timing,
}: CitationResolutionDrainOptions): Promise<void> => {
  let summary = emptySummary();
  let summaryDueAt = now() + timing.summaryIntervalMs;
  let idleMs = timing.idleSleepMs;
  let failureStreak = 0;
  let contradictingWindows = 0;

  const flushSummary = async (): Promise<void> => {
    try {
      summary.pending = await readPending();
    } catch (error) {
      summary.errored += 1;
      summary.lastErrorTag = errorTag(error);
      summary.lastErrorPgFields = pgErrorFields(error);
    }
    contradictingWindows = windowContradicts(summary)
      ? contradictingWindows + 1
      : 0;
    summary.idleContradictionWindows =
      contradictingWindows >= timing.idleContradictionWindows
        ? contradictingWindows
        : null;
    report(summary);
    summary = emptySummary();
    summaryDueAt = now() + timing.summaryIntervalMs;
  };

  while (!isDraining()) {
    let delayMs = timing.batchDelayMs;

    try {
      const step = await settleBatch();
      failureStreak = 0;
      switch (step.type) {
        case CITATION_RESOLUTION_STEP.SETTLED: {
          summary.batches += 1;
          addCounts(summary, step.counts);
          idleMs = timing.idleSleepMs;
          break;
        }
        case CITATION_RESOLUTION_STEP.DRAINED: {
          summary.drained += 1;
          delayMs = idleMs;
          idleMs = Math.min(idleMs * 2, timing.idleSleepMaxMs);
          break;
        }
        case CITATION_RESOLUTION_STEP.BUSY: {
          summary.busy += 1;
          delayMs = idleMs;
          idleMs = Math.min(idleMs * 2, timing.idleSleepMaxMs);
          break;
        }
        default: {
          step satisfies never;
          return panic(
            `Unhandled citation resolution step: ${JSON.stringify(step)}`,
          );
        }
      }
    } catch (error) {
      failureStreak += 1;
      summary.errored += 1;
      summary.lastErrorTag = errorTag(error);
      summary.lastErrorPgFields = pgErrorFields(error);
      // From its own floor, not from the duty cycle: a backfill may set the
      // batch gap to zero, and a database refusing statements must not then be
      // asked again as fast as it can refuse.
      delayMs = Math.min(
        Math.max(timing.batchDelayMs, timing.failureBackoffMinMs) *
          2 ** (failureStreak - 1),
        timing.failureBackoffMaxMs,
      );
    }

    if (now() >= summaryDueAt) {
      await flushSummary();
    }

    // Sliced so a drain request interrupts an idle ceiling of minutes within a
    // second; a gap under one slice sleeps once.
    let remainingMs = delayMs;
    while (remainingMs > 0 && !isDraining()) {
      const sliceMs = Math.min(remainingMs, CITATION_RESOLUTION_CHECK_SLICE_MS);
      await sleep(sliceMs);
      remainingMs -= sliceMs;
    }
  }

  // A deployment must not discard the window in hand: without this the tallies
  // of a process replaced mid-window are never reported at all.
  await flushSummary();
};
