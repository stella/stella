/**
 * How an ingestion cycle ended, whether that counts as forward progress, and
 * what cadence the next cycle deserves.
 *
 * Kept free of the runner's DB and env imports so the classification can be
 * exercised on its own.
 */

import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

export const CYCLE_OUTCOME = {
  COMPLETED: "completed",
  FAILED: "failed",
  TIMEOUT: "timeout",
} as const;

export type CycleOutcome = (typeof CYCLE_OUTCOME)[keyof typeof CYCLE_OUTCOME];

export type CycleResult = {
  outcome: CycleOutcome;
  /** Decisions written: inserts and updates both. */
  inserted: number;
  /** Decisions the dedup short-circuit dropped as already stored, unchanged. */
  skipped: number;
  pagesProcessed: number;
  /**
   * Whether the persisted cursor ended the cycle somewhere new.
   *
   * Distance travelled, which `pagesProcessed` deliberately is not: an adapter
   * that re-returns its current cursor walks a page per poll without moving
   * (cz-nss yields `${today}:0` once it reaches today). Only this separates a
   * source with nothing left from one still working through it.
   */
  cursorAdvanced: boolean;
};

/**
 * Forward progress is durable movement through the source, not how the cycle
 * ended and not how much it wrote.
 *
 * A cycle ends early whenever the pipeline sets a halt reason, and some halts
 * follow real work: a page whose corpus writes partly failed holds its cursor
 * and stops the cycle, but the pages before it advanced the cursor and their
 * rows were written. Classifying that as a stall both raises the
 * sustained-failure signal on a source that is ingesting normally and pins the
 * adapter to the failure backoff, throttling the very source that is keeping
 * up.
 *
 * `pagesProcessed` is the durable marker because the pipeline increments it
 * only after a page completes without halting, in the same step that advances
 * the cursor. `inserted` deliberately does NOT count: a corpus-write failure
 * preserves the row's previous source hash so the decision is reprocessed, so
 * a page parked on a persistent failure reports rows written on every retry
 * while the cursor never moves. Reading that as progress would reset the
 * streak and the backoff forever, silencing the alert on the one case it
 * exists to catch and hot-looping the adapter over a page it cannot pass.
 *
 * A "completed" cycle counts even with nothing to show for it: an adapter that
 * is caught up legitimately walks no pages and inserts nothing.
 */
export const cycleMadeProgress = ({
  outcome,
  pagesProcessed,
}: CycleResult): boolean =>
  outcome === CYCLE_OUTCOME.COMPLETED || pagesProcessed > 0;

/**
 * What a cycle says about the source's productivity, independent of how the
 * cycle ended.
 *
 * The outcome alone cannot answer this. An adapter whose page budget does not
 * fit its cycle deadline ends every cycle on a timeout, so any classification
 * keyed on `CYCLE_OUTCOME.COMPLETED` reads a source that re-fetches its whole
 * stored corpus every cycle, writing nothing, as indistinguishable from a
 * source that is keeping up.
 */
export const CYCLE_PRODUCTIVITY = {
  /**
   * The source is moving, however the cycle ended: rows written, or the cursor
   * carried forward over listings that yielded none.
   */
  PRODUCTIVE: "productive",
  /**
   * Nothing fetched, nothing written, and the cursor stood still: the source
   * is caught up.
   */
  QUIET: "quiet",
  /**
   * Decisions fetched, none written: the adapter re-read ground it already
   * holds. Sustained, this is work without progress.
   */
  UNPRODUCTIVE_RESCAN: "unproductive_rescan",
  /**
   * Ended before a decision was fetched, and not cleanly. Evidence of neither
   * quiet nor re-scan; a stall of this shape is what `cycleMadeProgress`
   * covers.
   */
  INCONCLUSIVE: "inconclusive",
} as const;

export type CycleProductivity =
  (typeof CYCLE_PRODUCTIVITY)[keyof typeof CYCLE_PRODUCTIVITY];

/**
 * Decisions the pipeline handled this cycle.
 *
 * The pipeline counts every decision it reaches as either written
 * (`inserted`, covering inserts and updates) or `skipped` (already stored and
 * unchanged, or failed), so the sum separates "fetched decisions and wrote
 * none" from "found nothing to fetch".
 */
export const cycleDecisionsProcessed = ({
  inserted,
  skipped,
}: CycleResult): number => inserted + skipped;

export const classifyCycleProductivity = (
  cycle: CycleResult,
): CycleProductivity => {
  if (cycle.inserted > 0) {
    return CYCLE_PRODUCTIVITY.PRODUCTIVE;
  }
  if (cycleDecisionsProcessed(cycle) > 0) {
    return CYCLE_PRODUCTIVITY.UNPRODUCTIVE_RESCAN;
  }
  // Order matters: a cursor that advances while decisions are re-read is the
  // forward re-ingest the re-scan backoff deliberately accepts a cost on, so
  // the re-scan check stays ahead of this one. Reaching here means the cycle
  // fetched no decisions at all, and a cursor that still moved covered listing
  // ground with none to give: an enumeration walking a stretch of the source
  // it does not hold. Reading that as caught up parks a running backfill on
  // the daily cadence, where it advances one page budget per day.
  if (cycle.cursorAdvanced) {
    return CYCLE_PRODUCTIVITY.PRODUCTIVE;
  }
  return cycle.outcome === CYCLE_OUTCOME.COMPLETED
    ? CYCLE_PRODUCTIVITY.QUIET
    : CYCLE_PRODUCTIVITY.INCONCLUSIVE;
};

/** How often the adapter loop should start the next cycle. */
export const CYCLE_CADENCE = {
  FAST: "fast",
  /** Caught up: poll once a day instead of hammering court servers. */
  CAUGHT_UP: "caught_up",
  /** Re-fetching stored decisions: hold the slot for adapters with work. */
  UNPRODUCTIVE_BACKOFF: "unproductive_backoff",
} as const;

export type CycleCadence = (typeof CYCLE_CADENCE)[keyof typeof CYCLE_CADENCE];

const FAST_DELAY_MS = 5000;

const HOURLY_DELAY_MS = 60 * 60 * 1000;

/**
 * Being caught up is a conclusion; re-fetching stored decisions is only
 * evidence, so the two do not earn the same delay.
 *
 * A source with nothing left to give has told us so, and daily is the right
 * cadence for asking again. A source writing nothing while it fetches is
 * either the pathology this classifier exists to catch or a re-ingest walking
 * forward through ground it already holds, and those two look identical from
 * here: both fetch, neither writes. Only the second is harmed by waiting, and
 * it is harmed badly, since it advances no further than one cycle per delay
 * and a long stored stretch would take months at a daily cadence.
 *
 * So the backoff is hourly. Against the pathology that is still a 720-fold
 * reduction on the fast cadence and the telemetry below names it either way;
 * against a legitimate catch-up walk it costs a day rather than a season.
 * Either way a cycle that writes returns to the fast cadence immediately.
 */
export const CYCLE_CADENCE_DELAY_MS = {
  [CYCLE_CADENCE.FAST]: FAST_DELAY_MS,
  [CYCLE_CADENCE.CAUGHT_UP]: DAY_IN_MS,
  [CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF]: HOURLY_DELAY_MS,
} as const satisfies Record<CycleCadence, number>;

/**
 * Consecutive cycles an adapter has spent caught up, and consecutive cycles it
 * has spent re-fetching stored decisions. Separate counters: only one can be
 * running at a time, and each escalates on its own evidence.
 */
export type CadenceStreaks = {
  quietCycles: number;
  unproductiveCycles: number;
};

export const INITIAL_CADENCE_STREAKS = {
  quietCycles: 0,
  unproductiveCycles: 0,
} as const satisfies CadenceStreaks;

/** Consecutive cycles of a kind before the cadence escalates. */
export const QUIET_THRESHOLD = 3;
export const UNPRODUCTIVE_THRESHOLD = 3;

const advanceStreaks = (
  streaks: CadenceStreaks,
  productivity: CycleProductivity,
): CadenceStreaks => {
  switch (productivity) {
    case CYCLE_PRODUCTIVITY.PRODUCTIVE:
      return { quietCycles: 0, unproductiveCycles: 0 };
    case CYCLE_PRODUCTIVITY.QUIET:
      // Nothing left to fetch ends a re-scan as surely as a written row does.
      return { quietCycles: streaks.quietCycles + 1, unproductiveCycles: 0 };
    case CYCLE_PRODUCTIVITY.UNPRODUCTIVE_RESCAN:
      return {
        quietCycles: 0,
        unproductiveCycles: streaks.unproductiveCycles + 1,
      };
    case CYCLE_PRODUCTIVITY.INCONCLUSIVE:
      // No evidence either way, so it is not evidence against: a cycle that
      // dies before its first fetch must not silently clear a running
      // re-scan. It does clear the quiet streak, because a cycle that ended
      // early left a source with work outstanding.
      return { quietCycles: 0, unproductiveCycles: streaks.unproductiveCycles };
    default: {
      productivity satisfies never;
      return panic(`Unhandled cycle productivity: ${String(productivity)}`);
    }
  }
};

const cadenceForStreaks = ({
  quietCycles,
  unproductiveCycles,
}: CadenceStreaks): CycleCadence => {
  if (unproductiveCycles >= UNPRODUCTIVE_THRESHOLD) {
    return CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF;
  }
  return quietCycles >= QUIET_THRESHOLD
    ? CYCLE_CADENCE.CAUGHT_UP
    : CYCLE_CADENCE.FAST;
};

/** Telemetry payload for a re-scan that has crossed the threshold. */
export type UnproductiveRescanSignal = {
  unproductiveCycles: number;
  decisionsProcessed: number;
  decisionsWritten: number;
};

export type CadenceStep = {
  productivity: CycleProductivity;
  streaks: CadenceStreaks;
  cadence: CycleCadence;
  /**
   * Non-null on every cycle at or past the threshold, not only the one that
   * crosses it: the hourly cadence bounds the signal rate, and a
   * condition that stops being reported looks identical to one that cleared.
   */
  unproductiveRescan: UnproductiveRescanSignal | null;
};

/**
 * Fold one cycle into an adapter's cadence state.
 *
 * Pure so the escalation can be exercised over whole cycle sequences: the
 * production defect this replaces was a streak that never reached its
 * threshold, which no single-cycle assertion can catch.
 */
export const stepCadence = (
  streaks: CadenceStreaks,
  cycle: CycleResult,
): CadenceStep => {
  const productivity = classifyCycleProductivity(cycle);
  const next = advanceStreaks(streaks, productivity);
  return {
    productivity,
    streaks: next,
    cadence: cadenceForStreaks(next),
    unproductiveRescan:
      next.unproductiveCycles >= UNPRODUCTIVE_THRESHOLD
        ? {
            unproductiveCycles: next.unproductiveCycles,
            decisionsProcessed: cycleDecisionsProcessed(cycle),
            decisionsWritten: cycle.inserted,
          }
        : null,
  };
};

/**
 * Consecutive cycles that advanced no page, and whether the running stall
 * episode has already been reported as an exception. One streak whatever the
 * stall's shape (failed cycle, thrown cycle, timeout with no pages), so an
 * adapter alternating between shapes still reaches the threshold.
 */
export type StallAlertState = {
  noProgressStreak: number;
  captured: boolean;
};

export const INITIAL_STALL_ALERT = {
  noProgressStreak: 0,
  captured: false,
} as const satisfies StallAlertState;

export type StallAlertStep = {
  state: StallAlertState;
  /** The streak that reached the threshold this cycle; null below it. */
  sustained: number | null;
  /**
   * True only on the episode's first threshold crossing. The sustained log
   * signal re-fires on every crossing so an ongoing outage stays visible,
   * but exception capture is for a human, and a human needs one exception
   * per outage, not one per crossing of it.
   */
  capture: boolean;
};

/**
 * Fold one cycle's progress verdict into the stall-alert state. Pure for the
 * same reason as `stepCadence`: only a whole-sequence test can show that a
 * long outage is captured exactly once and a recovery re-arms the capture.
 */
export const stepStallAlert = (
  state: StallAlertState,
  madeProgress: boolean,
  threshold: number,
): StallAlertStep => {
  if (madeProgress) {
    return { state: INITIAL_STALL_ALERT, sustained: null, capture: false };
  }
  const streak = state.noProgressStreak + 1;
  if (streak < threshold) {
    return {
      state: { noProgressStreak: streak, captured: state.captured },
      sustained: null,
      capture: false,
    };
  }
  // The streak resets on report so the log signal paces itself at one line
  // per threshold-worth of cycles; the latch is what remembers the episode.
  return {
    state: { noProgressStreak: 0, captured: true },
    sustained: streak,
    capture: !state.captured,
  };
};
