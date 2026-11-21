import { expect, test } from "bun:test";

import { createSettlingDeadlineSignal } from "./settling-deadline";

test("the cooperative abort precedes the hard deadline by the settle margin", () => {
  let clock = 10_000;
  let abortAt: number | undefined;
  const hardDeadlineMs = 45_000;
  const settleMarginMs = 5000;

  createSettlingDeadlineSignal({
    hardDeadlineMs,
    settleMarginMs,
    timeoutSignal: (delayMs) => {
      abortAt = clock + delayMs;
      return new AbortController().signal;
    },
  });
  const hardExitAt = clock + hardDeadlineMs;
  clock = abortAt ?? clock;

  expect(clock).toBe(hardExitAt - settleMarginMs);
  expect(clock).toBeLessThan(hardExitAt);
});
