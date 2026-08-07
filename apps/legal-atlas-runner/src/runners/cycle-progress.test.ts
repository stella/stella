import { describe, expect, test } from "bun:test";

import {
  CYCLE_CADENCE,
  CYCLE_CADENCE_DELAY_MS,
  CYCLE_OUTCOME,
  CYCLE_PRODUCTIVITY,
  type CadenceStep,
  type CadenceStreaks,
  type CycleOutcome,
  type CycleResult,
  INITIAL_CADENCE_STREAKS,
  QUIET_THRESHOLD,
  UNPRODUCTIVE_THRESHOLD,
  classifyCycleProductivity,
  cycleMadeProgress,
  stepCadence,
} from "./cycle-progress";

const OUTCOMES = Object.values(CYCLE_OUTCOME) satisfies readonly CycleOutcome[];

/** Rows written in a cycle, spanning none through many. */
const INSERTED = [0, 1, 250] as const;
/** Decisions the dedup short-circuit dropped; 550 is a whole stored corpus. */
const SKIPPED = [0, 1, 550] as const;
const PAGES = [0, 1] as const;

/** Every shape a returned cycle can take. */
const CYCLES = OUTCOMES.flatMap((outcome) =>
  INSERTED.flatMap((inserted) =>
    SKIPPED.flatMap((skipped) =>
      PAGES.map((pagesProcessed) => ({
        outcome,
        inserted,
        skipped,
        pagesProcessed,
      })),
    ),
  ),
) satisfies readonly CycleResult[];

/**
 * The cycle that escaped detection in production: the page budget could not
 * fit the cycle deadline, so every cycle timed out after re-fetching the whole
 * stored corpus and writing nothing.
 */
const RESCAN_CYCLE = {
  outcome: CYCLE_OUTCOME.TIMEOUT,
  inserted: 0,
  skipped: 550,
  pagesProcessed: 12,
} satisfies CycleResult;

/** The same adapter while it is genuinely writing rows, still too slow to finish. */
const SLOW_PRODUCTIVE_CYCLE = {
  outcome: CYCLE_OUTCOME.TIMEOUT,
  inserted: 40,
  skipped: 510,
  pagesProcessed: 12,
} satisfies CycleResult;

const QUIET_CYCLE = {
  outcome: CYCLE_OUTCOME.COMPLETED,
  inserted: 0,
  skipped: 0,
  pagesProcessed: 1,
} satisfies CycleResult;

const INCONCLUSIVE_CYCLE = {
  outcome: CYCLE_OUTCOME.TIMEOUT,
  inserted: 0,
  skipped: 0,
  pagesProcessed: 0,
} satisfies CycleResult;

const repeat = (cycle: CycleResult, times: number): CycleResult[] =>
  Array.from({ length: times }, () => cycle);

/** Fold a run of cycles the way the adapter loop does, keeping every step. */
const runCycles = (cycles: readonly CycleResult[]): CadenceStep[] => {
  let streaks: CadenceStreaks = INITIAL_CADENCE_STREAKS;
  const steps: CadenceStep[] = [];
  for (const cycle of cycles) {
    const step = stepCadence(streaks, cycle);
    streaks = step.streaks;
    steps.push(step);
  }
  return steps;
};

const lastStep = (cycles: readonly CycleResult[]): CadenceStep => {
  const steps = runCycles(cycles);
  const last = steps.at(-1);
  if (!last) {
    throw new Error("runCycles needs at least one cycle");
  }
  return last;
};

describe("cycleMadeProgress", () => {
  test("a cycle that advanced a page is progress, however it ended", () => {
    const stalls = CYCLES.filter(
      (cycle) => cycle.pagesProcessed > 0 && !cycleMadeProgress(cycle),
    );

    expect(stalls).toEqual([]);
  });

  test("rows written without advancing a page are not progress", () => {
    // A corpus-write failure parks the page and preserves the row's previous
    // source hash, so the same decisions are rewritten on every retry. Counting
    // that as progress would reset the streak and backoff forever.
    const progressed = CYCLES.filter(
      (cycle) =>
        cycle.outcome !== CYCLE_OUTCOME.COMPLETED &&
        cycle.inserted > 0 &&
        cycle.pagesProcessed === 0,
    ).filter(cycleMadeProgress);

    expect(progressed).toEqual([]);
  });

  test("a cycle that moved nothing and did not complete is a stall", () => {
    expect(
      cycleMadeProgress({
        outcome: CYCLE_OUTCOME.FAILED,
        inserted: 0,
        skipped: 0,
        pagesProcessed: 0,
      }),
    ).toBe(false);
    expect(cycleMadeProgress(INCONCLUSIVE_CYCLE)).toBe(false);
  });

  test("a completed cycle with nothing to do is not a stall", () => {
    expect(
      cycleMadeProgress({
        outcome: CYCLE_OUTCOME.COMPLETED,
        inserted: 0,
        skipped: 0,
        pagesProcessed: 0,
      }),
    ).toBe(true);
  });
});

describe("classifyCycleProductivity", () => {
  test("the declared states are exactly the reachable ones", () => {
    const produced = new Set(CYCLES.map(classifyCycleProductivity));

    expect([...produced].toSorted()).toEqual(
      Object.values(CYCLE_PRODUCTIVITY).toSorted(),
    );
  });

  test("re-fetching stored decisions and writing none is an unproductive re-scan", () => {
    // The production case: every cycle ended on a timeout, so any check keyed
    // on CYCLE_OUTCOME.COMPLETED read this as a source that was keeping up.
    expect(classifyCycleProductivity(RESCAN_CYCLE)).toBe(
      CYCLE_PRODUCTIVITY.UNPRODUCTIVE_RESCAN,
    );

    const misread = CYCLES.filter(
      (cycle) => cycle.inserted === 0 && cycle.skipped > 0,
    ).filter(
      (cycle) =>
        classifyCycleProductivity(cycle) !==
        CYCLE_PRODUCTIVITY.UNPRODUCTIVE_RESCAN,
    );

    expect(misread).toEqual([]);
  });

  test("a cycle that wrote rows is productive whatever it skipped or how it ended", () => {
    const misread = CYCLES.filter((cycle) => cycle.inserted > 0).filter(
      (cycle) =>
        classifyCycleProductivity(cycle) !== CYCLE_PRODUCTIVITY.PRODUCTIVE,
    );

    expect(misread).toEqual([]);
  });

  test("only a clean cycle that fetched nothing is quiet", () => {
    expect(classifyCycleProductivity(QUIET_CYCLE)).toBe(
      CYCLE_PRODUCTIVITY.QUIET,
    );
    // The same counts on a cycle that ended early say nothing: the source may
    // still have work, so it must not read as caught up.
    expect(classifyCycleProductivity(INCONCLUSIVE_CYCLE)).toBe(
      CYCLE_PRODUCTIVITY.INCONCLUSIVE,
    );

    const quiet = CYCLES.filter(
      (cycle) => classifyCycleProductivity(cycle) === CYCLE_PRODUCTIVITY.QUIET,
    );

    expect(
      quiet.every(
        (cycle) =>
          cycle.outcome === CYCLE_OUTCOME.COMPLETED &&
          cycle.inserted === 0 &&
          cycle.skipped === 0,
      ),
    ).toBe(true);
  });
});

describe("stepCadence", () => {
  test("the delay map covers exactly the declared cadences", () => {
    expect(Object.keys(CYCLE_CADENCE_DELAY_MS).toSorted()).toEqual(
      Object.values(CYCLE_CADENCE).toSorted(),
    );
  });

  test("a sustained re-scan backs off and raises the signal", () => {
    const steps = runCycles(repeat(RESCAN_CYCLE, UNPRODUCTIVE_THRESHOLD));
    const tripped = steps.at(-1);

    expect(steps.slice(0, -1).map((step) => step.cadence)).toEqual(
      Array.from(
        { length: UNPRODUCTIVE_THRESHOLD - 1 },
        () => CYCLE_CADENCE.FAST,
      ),
    );
    expect(steps.slice(0, -1).map((step) => step.unproductiveRescan)).toEqual(
      Array.from({ length: UNPRODUCTIVE_THRESHOLD - 1 }, () => null),
    );
    expect(tripped?.cadence).toBe(CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF);
    expect(tripped?.unproductiveRescan).toEqual({
      unproductiveCycles: UNPRODUCTIVE_THRESHOLD,
      decisionsProcessed: RESCAN_CYCLE.skipped,
      decisionsWritten: 0,
    });
    expect(
      CYCLE_CADENCE_DELAY_MS[CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF],
    ).toBeGreaterThan(CYCLE_CADENCE_DELAY_MS[CYCLE_CADENCE.FAST]);
  });

  test("the signal keeps firing while the condition holds", () => {
    // Once backed off the adapter cycles about once a day, so re-reporting is
    // not a flood; going silent would look exactly like a cleared condition.
    const steps = runCycles(repeat(RESCAN_CYCLE, UNPRODUCTIVE_THRESHOLD + 2));

    expect(
      steps
        .slice(UNPRODUCTIVE_THRESHOLD - 1)
        .map((step) => step.unproductiveRescan),
    ).toEqual([
      {
        unproductiveCycles: UNPRODUCTIVE_THRESHOLD,
        decisionsProcessed: RESCAN_CYCLE.skipped,
        decisionsWritten: 0,
      },
      {
        unproductiveCycles: UNPRODUCTIVE_THRESHOLD + 1,
        decisionsProcessed: RESCAN_CYCLE.skipped,
        decisionsWritten: 0,
      },
      {
        unproductiveCycles: UNPRODUCTIVE_THRESHOLD + 2,
        decisionsProcessed: RESCAN_CYCLE.skipped,
        decisionsWritten: 0,
      },
    ]);
  });

  test("a slow but productive adapter is never throttled", () => {
    // The correctness constraint on the whole change: a cycle that times out
    // while writing rows must keep the fast cadence, however long it runs.
    const steps = runCycles(repeat(SLOW_PRODUCTIVE_CYCLE, 50));

    expect(steps.filter((step) => step.cadence !== CYCLE_CADENCE.FAST)).toEqual(
      [],
    );
    expect(steps.filter((step) => step.unproductiveRescan !== null)).toEqual(
      [],
    );
  });

  test("any cycle that wrote a row restores the fast cadence, from any history", () => {
    const histories = [
      repeat(RESCAN_CYCLE, UNPRODUCTIVE_THRESHOLD + 2),
      repeat(QUIET_CYCLE, QUIET_THRESHOLD + 2),
      repeat(INCONCLUSIVE_CYCLE, 4),
    ];
    const productive = CYCLES.filter((cycle) => cycle.inserted > 0);

    const throttled = histories.flatMap((history) =>
      productive
        .map((cycle) => lastStep([...history, cycle]))
        .filter((step) => step.cadence !== CYCLE_CADENCE.FAST),
    );

    expect(throttled).toEqual([]);
  });

  test("a quiet source reaches the caught-up cadence as before", () => {
    const steps = runCycles(repeat(QUIET_CYCLE, QUIET_THRESHOLD));

    expect(steps.map((step) => step.cadence)).toEqual([
      ...Array.from({ length: QUIET_THRESHOLD - 1 }, () => CYCLE_CADENCE.FAST),
      CYCLE_CADENCE.CAUGHT_UP,
    ]);
    expect(steps.at(-1)?.unproductiveRescan).toBeNull();
  });

  test("a quiet cycle ends a re-scan streak", () => {
    // Nothing left to fetch is the source being caught up, not a stall.
    const step = lastStep([
      ...repeat(RESCAN_CYCLE, UNPRODUCTIVE_THRESHOLD),
      QUIET_CYCLE,
    ]);

    expect(step.cadence).toBe(CYCLE_CADENCE.FAST);
    expect(step.streaks).toEqual({ quietCycles: 1, unproductiveCycles: 0 });
  });

  test("a cycle that fetched nothing and ended early holds the re-scan streak", () => {
    // It is evidence of neither state, so it must not silently clear a
    // running re-scan; it does clear the quiet streak, since the source has
    // work outstanding.
    const held = lastStep([
      ...repeat(RESCAN_CYCLE, UNPRODUCTIVE_THRESHOLD - 1),
      INCONCLUSIVE_CYCLE,
      RESCAN_CYCLE,
    ]);
    expect(held.cadence).toBe(CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF);

    const cleared = lastStep([
      ...repeat(QUIET_CYCLE, QUIET_THRESHOLD - 1),
      INCONCLUSIVE_CYCLE,
      QUIET_CYCLE,
    ]);
    expect(cleared.cadence).toBe(CYCLE_CADENCE.FAST);
  });

  test("the signal fires exactly when the cadence is the unproductive backoff", () => {
    const mismatched = CYCLES.flatMap((cycle) =>
      runCycles(repeat(cycle, UNPRODUCTIVE_THRESHOLD + 1)),
    ).filter(
      (step) =>
        (step.unproductiveRescan !== null) !==
        (step.cadence === CYCLE_CADENCE.UNPRODUCTIVE_BACKOFF),
    );

    expect(mismatched).toEqual([]);
  });

  test("every declared cadence is reachable", () => {
    const reached = new Set(
      CYCLES.flatMap((cycle) =>
        runCycles(
          repeat(cycle, Math.max(QUIET_THRESHOLD, UNPRODUCTIVE_THRESHOLD)),
        ),
      ).map((step) => step.cadence),
    );

    expect([...reached].toSorted()).toEqual(
      Object.values(CYCLE_CADENCE).toSorted(),
    );
  });
});
