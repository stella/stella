import { describe, expect, test } from "bun:test";

import {
  acquireReplayLease,
  REPLAY_LEASE_RETRY_PAUSE_MS,
} from "@/api/handlers/case-law/ingestion/replay";

// Stands in for the lease itself: the wait reads nothing from it.
const LEASE = { source: "acquired" };

// Refuses the first `refusals` attempts, the way an ingestion that takes the
// lease per reconciliation unit refuses everyone until it reaches a gap.
const refusingAcquire = (refusals: number) => {
  let attempts = 0;
  return {
    acquire: async () => {
      attempts += 1;
      return await Promise.resolve(attempts > refusals ? LEASE : null);
    },
    attempts: () => attempts,
  };
};

// Nothing sleeps: the budget is spent in recorded pauses, so a thirty-minute
// wait costs the test nothing.
const recordingSleep = () => {
  const pauses: number[] = [];
  return {
    pauses,
    sleep: async (ms: number) => {
      pauses.push(ms);
      await Promise.resolve();
    },
  };
};

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

describe("waiting for a source's ingestion lease", () => {
  test("takes a free lease without pausing", async () => {
    const { acquire, attempts } = refusingAcquire(0);
    const { pauses, sleep } = recordingSleep();
    let announced = 0;

    const acquisition = await acquireReplayLease({
      acquire,
      waitBudgetMs: THIRTY_MINUTES_MS,
      onWaitStart: () => {
        announced += 1;
      },
      sleep,
    });

    expect(acquisition).toEqual({
      type: "acquired",
      lease: LEASE,
      waitedMs: 0,
    });
    expect(attempts()).toBe(1);
    expect(pauses).toEqual([]);
    expect(announced).toBe(0);
  });

  test("retries on a fixed pause until the holder releases", async () => {
    const { acquire, attempts } = refusingAcquire(3);
    const { pauses, sleep } = recordingSleep();
    let announced = 0;

    const acquisition = await acquireReplayLease({
      acquire,
      waitBudgetMs: THIRTY_MINUTES_MS,
      onWaitStart: () => {
        announced += 1;
      },
      sleep,
    });

    expect(acquisition).toEqual({
      type: "acquired",
      lease: LEASE,
      waitedMs: 3 * REPLAY_LEASE_RETRY_PAUSE_MS,
    });
    expect(attempts()).toBe(4);
    expect(pauses).toEqual([
      REPLAY_LEASE_RETRY_PAUSE_MS,
      REPLAY_LEASE_RETRY_PAUSE_MS,
      REPLAY_LEASE_RETRY_PAUSE_MS,
    ]);
    // Said once, however long the wait runs.
    expect(announced).toBe(1);
  });

  test("gives up once the budget is spent, and pauses no longer than it", async () => {
    const { acquire, attempts } = refusingAcquire(Number.POSITIVE_INFINITY);
    const { pauses, sleep } = recordingSleep();
    const waitBudgetMs = 30_000;

    const acquisition = await acquireReplayLease({
      acquire,
      waitBudgetMs,
      sleep,
    });

    expect(acquisition).toEqual({
      type: "unavailable",
      waitedMs: waitBudgetMs,
    });
    expect(pauses.reduce((total, ms) => total + ms, 0)).toBe(waitBudgetMs);
    // Every pause is preceded by an attempt, and the budget buys one more.
    expect(attempts()).toBe(pauses.length + 1);
  });

  test("attempts once and reports the holder when the budget is zero", async () => {
    const { acquire, attempts } = refusingAcquire(Number.POSITIVE_INFINITY);
    const { pauses, sleep } = recordingSleep();
    let announced = 0;

    const acquisition = await acquireReplayLease({
      acquire,
      waitBudgetMs: 0,
      onWaitStart: () => {
        announced += 1;
      },
      sleep,
    });

    expect(acquisition).toEqual({ type: "unavailable", waitedMs: 0 });
    expect(attempts()).toBe(1);
    expect(pauses).toEqual([]);
    expect(announced).toBe(0);
  });
});
