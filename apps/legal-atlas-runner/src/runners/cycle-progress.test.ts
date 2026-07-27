import { describe, expect, test } from "bun:test";

import {
  CYCLE_OUTCOME,
  type CycleOutcome,
  cycleMadeProgress,
  cycleWasIdle,
} from "./cycle-progress";

const OUTCOMES = Object.values(CYCLE_OUTCOME) satisfies readonly CycleOutcome[];

/** Rows written in a cycle, spanning none through many. */
const INSERTED = [0, 1, 250] as const;

describe("cycleMadeProgress", () => {
  test("a cycle that advanced a page is progress, however it ended", () => {
    const stalls = OUTCOMES.flatMap((outcome) =>
      INSERTED.map((inserted) => ({ outcome, inserted, pagesProcessed: 1 })),
    ).filter((cycle) => !cycleMadeProgress(cycle));

    expect(stalls).toEqual([]);
  });

  test("rows written without advancing a page are not progress", () => {
    // A corpus-write failure parks the page and preserves the row's previous
    // source hash, so the same decisions are rewritten on every retry. Counting
    // that as progress would reset the streak and backoff forever.
    const progressed = OUTCOMES.filter(
      (outcome) => outcome !== CYCLE_OUTCOME.COMPLETED,
    )
      .flatMap((outcome) =>
        INSERTED.filter((inserted) => inserted > 0).map((inserted) => ({
          outcome,
          inserted,
          pagesProcessed: 0,
        })),
      )
      .filter(cycleMadeProgress);

    expect(progressed).toEqual([]);
  });

  test("a cycle that moved nothing and did not complete is a stall", () => {
    expect(
      cycleMadeProgress({
        outcome: CYCLE_OUTCOME.FAILED,
        inserted: 0,
        pagesProcessed: 0,
      }),
    ).toBe(false);
    expect(
      cycleMadeProgress({
        outcome: CYCLE_OUTCOME.TIMEOUT,
        inserted: 0,
        pagesProcessed: 0,
      }),
    ).toBe(false);
  });

  test("a completed cycle with nothing to do is not a stall", () => {
    expect(
      cycleMadeProgress({
        outcome: CYCLE_OUTCOME.COMPLETED,
        inserted: 0,
        pagesProcessed: 0,
      }),
    ).toBe(true);
  });
});

describe("cycleWasIdle", () => {
  test("a cycle that halted or timed out is never idle", () => {
    // Such a cycle stopped partway through a source that still has work.
    // Reading it as quiet would hold an adapter on the daily cadence.
    const idle = OUTCOMES.filter(
      (outcome) => outcome !== CYCLE_OUTCOME.COMPLETED,
    )
      .flatMap((outcome) =>
        INSERTED.flatMap((inserted) =>
          [0, 1].map((pagesProcessed) => ({
            outcome,
            inserted,
            pagesProcessed,
          })),
        ),
      )
      .filter(cycleWasIdle);

    expect(idle).toEqual([]);
  });

  test("only a completed cycle that found nothing is idle", () => {
    expect(
      cycleWasIdle({
        outcome: CYCLE_OUTCOME.COMPLETED,
        inserted: 0,
        pagesProcessed: 4,
      }),
    ).toBe(true);
    expect(
      cycleWasIdle({
        outcome: CYCLE_OUTCOME.COMPLETED,
        inserted: 1,
        pagesProcessed: 4,
      }),
    ).toBe(false);
  });
});
