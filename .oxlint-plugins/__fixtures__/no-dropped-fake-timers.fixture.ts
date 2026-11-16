// Passive regression fixture for
// `no-dropped-fake-timers/no-dropped-fake-timers`.

import { jest } from "bun:test";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";

export const leaveFakeTimersDirectly = (): void => {
  jest.useFakeTimers();
  // MUST flag: Bun discards the pending fake timeouts.
  // oxlint-disable-next-line no-dropped-fake-timers/no-dropped-fake-timers -- fixture: a direct switch drops pending fake timeouts
  jest.useRealTimers();
};

export const leaveFakeTimersSafely = (): void => {
  jest.useFakeTimers();
  // expect-clean: no-dropped-fake-timers/no-dropped-fake-timers
  restoreRealTimers();
};
