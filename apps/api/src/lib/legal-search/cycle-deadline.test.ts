import { describe, expect, test } from "bun:test";

import {
  canStartCyclePage,
  remainingCycleMs,
  startCycleDeadline,
} from "@/api/lib/legal-search/cycle-deadline";

describe("cycle deadline", () => {
  test("reports the budget it was started with", () => {
    const deadline = startCycleDeadline({ budgetMs: 60_000 });

    expect(remainingCycleMs(deadline)).toBeLessThanOrEqual(60_000);
    expect(remainingCycleMs(deadline)).toBeGreaterThan(59_000);
  });

  test("refuses a page longer than what is left of the budget", () => {
    const deadline = startCycleDeadline({ budgetMs: 1000 });

    // The signal has not fired: a page is refused because it cannot finish,
    // not because the cycle is already over.
    expect(deadline.signal.aborted).toBe(false);
    expect(canStartCyclePage(deadline, 30_000)).toBe(false);
    expect(canStartCyclePage(deadline, 100)).toBe(true);
  });

  test("refuses every page once an outer signal aborts the cycle", () => {
    const drain = new AbortController();
    const deadline = startCycleDeadline({
      budgetMs: 60_000,
      abortEarlyOn: [drain.signal],
    });

    expect(canStartCyclePage(deadline, 100)).toBe(true);
    drain.abort();
    expect(canStartCyclePage(deadline, 100)).toBe(false);
  });
});
