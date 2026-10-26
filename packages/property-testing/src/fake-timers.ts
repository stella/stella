import { jest } from "bun:test";

/**
 * Return to real timers after firing every timeout the fake clock holds.
 *
 * Bun discards pending fake timeouts when real timers return. A library that
 * keeps module state until its timeout fires (a component library's focus and
 * dismiss timers) then never clears it, so whichever tests run after it in the
 * same file wait on that state until they time out. The fake clock advances
 * only to the latest timeout pending now, so an interval cannot keep the
 * restore running.
 *
 * A no-op while timers are real, so a shared teardown can call it after every
 * test.
 */
export const restoreRealTimers = (): void => {
  if (!jest.isFakeTimers()) {
    return;
  }
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
};
