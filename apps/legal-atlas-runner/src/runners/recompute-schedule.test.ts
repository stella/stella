import { describe, expect, test } from "bun:test";

import {
  RECOMPUTE_OUTCOME,
  type RecomputeOutcome,
  nextRecomputeDelayMs,
} from "./recompute-schedule";

const OUTCOMES = Object.values(
  RECOMPUTE_OUTCOME,
) satisfies readonly RecomputeOutcome[];

const RETRY_DELAY_MS = 10 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Well past the point where doubling saturates the cap. */
const FAILURE_RUN = Array.from({ length: 40 }, (_, i) => i + 1);

const delayAfterFailures = (consecutiveFailures: number): number =>
  nextRecomputeDelayMs({
    outcome: RECOMPUTE_OUTCOME.FAILED,
    consecutiveFailures,
    retryDelayMs: RETRY_DELAY_MS,
    intervalMs: INTERVAL_MS,
  });

describe("nextRecomputeDelayMs", () => {
  test("no outcome ever schedules sooner than the retry delay or later than the interval", () => {
    const outOfRange = OUTCOMES.flatMap((outcome) =>
      FAILURE_RUN.map((consecutiveFailures) => ({
        outcome,
        delay: nextRecomputeDelayMs({
          outcome,
          consecutiveFailures:
            outcome === RECOMPUTE_OUTCOME.FAILED ? consecutiveFailures : 0,
          retryDelayMs: RETRY_DELAY_MS,
          intervalMs: INTERVAL_MS,
        }),
      })),
    ).filter(({ delay }) => delay < RETRY_DELAY_MS || delay > INTERVAL_MS);

    expect(outOfRange).toEqual([]);
  });

  test("a run of failures backs off monotonically and settles at the interval", () => {
    const delays = FAILURE_RUN.map(delayAfterFailures);
    const regressions = delays.filter(
      (delay, i) => i > 0 && delay < (delays[i - 1] ?? 0),
    );

    expect(regressions).toEqual([]);
    expect(delays.at(0)).toBe(RETRY_DELAY_MS);
    expect(delays.at(-1)).toBe(INTERVAL_MS);
  });

  test("a skip keeps the short retry however long the recompute has been failing", () => {
    // The lock holder may exit before committing; its replacement should not
    // inherit a gap, and a skip is not evidence the recompute cannot finish.
    expect(
      nextRecomputeDelayMs({
        outcome: RECOMPUTE_OUTCOME.SKIPPED,
        consecutiveFailures: 0,
        retryDelayMs: RETRY_DELAY_MS,
        intervalMs: INTERVAL_MS,
      }),
    ).toBe(RETRY_DELAY_MS);
  });

  test("idle waits the full interval", () => {
    expect(
      nextRecomputeDelayMs({
        outcome: RECOMPUTE_OUTCOME.IDLE,
        consecutiveFailures: 0,
        retryDelayMs: RETRY_DELAY_MS,
        intervalMs: INTERVAL_MS,
      }),
    ).toBe(INTERVAL_MS);
  });

  test("fresh waits out the remainder, clamped into the schedule's range", () => {
    const freshDelay = (freshRemainingMs: number): number =>
      nextRecomputeDelayMs({
        outcome: RECOMPUTE_OUTCOME.FRESH,
        consecutiveFailures: 0,
        freshRemainingMs,
        retryDelayMs: RETRY_DELAY_MS,
        intervalMs: INTERVAL_MS,
      });

    expect(freshDelay(2 * 60 * 60 * 1000)).toBe(2 * 60 * 60 * 1000);
    expect(freshDelay(1)).toBe(RETRY_DELAY_MS);
    expect(freshDelay(INTERVAL_MS * 2)).toBe(INTERVAL_MS);
  });

  test("a recompute that succeeded waits the full interval", () => {
    expect(
      nextRecomputeDelayMs({
        outcome: RECOMPUTE_OUTCOME.RECOMPUTED,
        consecutiveFailures: 0,
        retryDelayMs: RETRY_DELAY_MS,
        intervalMs: INTERVAL_MS,
      }),
    ).toBe(INTERVAL_MS);
  });
});
