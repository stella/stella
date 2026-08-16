import { describe, expect, test } from "bun:test";

import {
  RECOMPUTE_OUTCOME,
  type RecomputeOutcome,
  nextRecomputeDelayMs,
} from "./recompute-schedule";

const OUTCOMES = Object.values(
  RECOMPUTE_OUTCOME,
) satisfies readonly RecomputeOutcome[];

const BATCH_DELAY_MS = 2000;
const IDLE_DELAY_MS = 10 * 60 * 1000;

/** Well past the point where doubling saturates the cap. */
const FAILURE_RUN = Array.from({ length: 40 }, (_, i) => i + 1);

const delayAfterFailures = (consecutiveFailures: number): number =>
  nextRecomputeDelayMs({
    outcome: RECOMPUTE_OUTCOME.FAILED,
    consecutiveFailures,
    batchDelayMs: BATCH_DELAY_MS,
    idleDelayMs: IDLE_DELAY_MS,
  });

describe("nextRecomputeDelayMs", () => {
  test("no outcome ever schedules sooner than the batch gap or later than the idle poll", () => {
    const outOfRange = OUTCOMES.flatMap((outcome) =>
      FAILURE_RUN.map((consecutiveFailures) => ({
        outcome,
        delay: nextRecomputeDelayMs({
          outcome,
          consecutiveFailures:
            outcome === RECOMPUTE_OUTCOME.FAILED ? consecutiveFailures : 0,
          batchDelayMs: BATCH_DELAY_MS,
          idleDelayMs: IDLE_DELAY_MS,
        }),
      })),
    ).filter(({ delay }) => delay < BATCH_DELAY_MS || delay > IDLE_DELAY_MS);

    expect(outOfRange).toEqual([]);
  });

  test("a run of failures backs off monotonically and settles at the idle poll", () => {
    const delays = FAILURE_RUN.map(delayAfterFailures);
    const regressions = delays.filter(
      (delay, i) => i > 0 && delay < (delays[i - 1] ?? 0),
    );

    expect(regressions).toEqual([]);
    expect(delays.at(0)).toBe(BATCH_DELAY_MS);
    expect(delays.at(-1)).toBe(IDLE_DELAY_MS);
  });

  test("a batch that advanced pays only the duty cycle", () => {
    // Throughput is this gap and nothing else: a batch that recomputed rows
    // says there is more work, so backing off would be backwards.
    expect(
      nextRecomputeDelayMs({
        outcome: RECOMPUTE_OUTCOME.ADVANCED,
        consecutiveFailures: 0,
        batchDelayMs: BATCH_DELAY_MS,
        idleDelayMs: IDLE_DELAY_MS,
      }),
    ).toBe(BATCH_DELAY_MS);
  });

  test("a skip keeps the batch gap however long the sweep has been failing", () => {
    // The lock holder is doing the work; finding it held says nothing about
    // how much is left, and is not evidence the sweep cannot finish.
    // Across a whole run of failure counts, not just zero: the invariant is
    // that a skip is *never* backed off, and asserting it at zero would leave
    // a future change that applies the failure curve to SKIPPED passing.
    const delays = FAILURE_RUN.map((consecutiveFailures) =>
      nextRecomputeDelayMs({
        outcome: RECOMPUTE_OUTCOME.SKIPPED,
        consecutiveFailures,
        batchDelayMs: BATCH_DELAY_MS,
        idleDelayMs: IDLE_DELAY_MS,
      }),
    );
    expect(delays.filter((delay) => delay !== BATCH_DELAY_MS)).toEqual([]);
  });

  test("a current corpus and an unrankable one both wait the idle poll", () => {
    for (const outcome of [
      RECOMPUTE_OUTCOME.CURRENT,
      RECOMPUTE_OUTCOME.IDLE,
    ] as const) {
      expect(
        nextRecomputeDelayMs({
          outcome,
          consecutiveFailures: 0,
          batchDelayMs: BATCH_DELAY_MS,
          idleDelayMs: IDLE_DELAY_MS,
        }),
      ).toBe(IDLE_DELAY_MS);
    }
  });
});
