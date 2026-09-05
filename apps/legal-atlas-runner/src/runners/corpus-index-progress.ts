/**
 * How a corpus-index backfill step ended and whether a run of such endings
 * is a stall worth reporting.
 *
 * The loop's raw signal is too coarse on its own: `BUSY` (another writer
 * holds the generation lease) and a thrown step both look like idle silence
 * unless counted, and a leaked lease or a persistently failing backend shows
 * up only as such a run. Kept free of the runner's DB and env imports so the
 * escalation can be exercised over whole step sequences.
 */

import { panic } from "better-result";

export const CORPUS_INDEX_STEP = {
  /** The step indexed rows or advanced the generation walk. */
  ADVANCED: "advanced",
  /** Another writer held the generation lease for the whole step. */
  BUSY: "busy",
  /** Nothing pending and the walk is done: the index is caught up. */
  COMPLETE: "complete",
  /** The step threw. */
  FAILED: "failed",
} as const;

export type CorpusIndexStepKind =
  (typeof CORPUS_INDEX_STEP)[keyof typeof CORPUS_INDEX_STEP];

export type CorpusIndexStreaks = {
  busySteps: number;
  failedSteps: number;
};

export const INITIAL_CORPUS_INDEX_STREAKS = {
  busySteps: 0,
  failedSteps: 0,
} as const satisfies CorpusIndexStreaks;

/**
 * How long a condition must hold before it is reported: long enough to skip
 * lease handoffs and transient backend blips, short enough to name a leaked
 * lease well before its 30-minute expiry.
 */
export const CORPUS_INDEX_STALL_WINDOW_MS = 5 * 60_000;

/**
 * The window expressed as consecutive steps of the loop's configured
 * interval, which spans 250ms to 5 minutes. A fixed step count would report
 * after five seconds at the fast end and after 100 minutes at the slow end.
 * The floor of two keeps a single step from reporting at intervals at or
 * beyond the window, where one BUSY poll can still be a benign lease
 * handoff.
 */
export const corpusIndexStallThreshold = (intervalMs: number): number =>
  Math.max(
    2,
    Math.ceil(CORPUS_INDEX_STALL_WINDOW_MS / Math.max(1, intervalMs)),
  );

export type CorpusIndexStallSignal = {
  kind: "sustained_busy" | "sustained_failure";
  steps: number;
};

export type CorpusIndexProgressStep = {
  streaks: CorpusIndexStreaks;
  /**
   * Non-null each time a streak reaches the threshold. The returned streaks
   * reset the reported counter, so a persisting condition re-reports once
   * per threshold-run rather than once per step — bounded rate, and a
   * condition that stops being reported has actually cleared.
   */
  stall: CorpusIndexStallSignal | null;
};

type CorpusIndexProgressOptions = {
  kind: CorpusIndexStepKind;
  streaks: CorpusIndexStreaks;
  /** From corpusIndexStallThreshold(intervalMs), computed once per loop. */
  threshold: number;
};

/**
 * Fold one step into the loop's stall state.
 *
 * BUSY and FAILED keep separate counters and do not reset each other: both
 * are "no progress", and a wedge that alternates between them (a leaked
 * lease racing a failing backend) must still cross a threshold. Any step
 * that proves the subsystem live — rows indexed, or a clean caught-up
 * probe — clears both.
 */
export const stepCorpusIndexProgress = ({
  kind,
  streaks,
  threshold,
}: CorpusIndexProgressOptions): CorpusIndexProgressStep => {
  switch (kind) {
    case CORPUS_INDEX_STEP.ADVANCED:
    case CORPUS_INDEX_STEP.COMPLETE:
      return { streaks: INITIAL_CORPUS_INDEX_STREAKS, stall: null };
    case CORPUS_INDEX_STEP.BUSY: {
      const busySteps = streaks.busySteps + 1;
      if (busySteps < threshold) {
        return { streaks: { ...streaks, busySteps }, stall: null };
      }
      return {
        streaks: { ...streaks, busySteps: 0 },
        stall: { kind: "sustained_busy", steps: busySteps },
      };
    }
    case CORPUS_INDEX_STEP.FAILED: {
      const failedSteps = streaks.failedSteps + 1;
      if (failedSteps < threshold) {
        return { streaks: { ...streaks, failedSteps }, stall: null };
      }
      return {
        streaks: { ...streaks, failedSteps: 0 },
        stall: { kind: "sustained_failure", steps: failedSteps },
      };
    }
    default: {
      kind satisfies never;
      return panic(`Unhandled corpus index step: ${String(kind)}`);
    }
  }
};
