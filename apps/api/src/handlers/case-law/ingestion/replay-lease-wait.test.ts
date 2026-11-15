import { describe, expect, test } from "bun:test";

import {
  REPLAY_LEASE_RETRY_PAUSE_MS,
  runWithReplayLease,
} from "@/api/handlers/case-law/ingestion/replay";

// What the operation returns once it ran under the lease; the wait reads
// nothing from it.
const RAN = { source: "ran" };

// Refuses the first `refusals` attempts, the way an ingestion that takes the
// lease per reconciliation unit refuses everyone until it reaches a gap.
const refusingRun = (refusals: number) => {
  let attempts = 0;
  return {
    run: async () => {
      attempts += 1;
      return await Promise.resolve(attempts > refusals ? RAN : null);
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

describe("waiting for a source's ingestion lease to run one operation", () => {
  test("runs at once on a free lease without pausing", async () => {
    const { run, attempts } = refusingRun(0);
    const { pauses, sleep } = recordingSleep();
    let announced = 0;

    const acquisition = await runWithReplayLease({
      run,
      waitBudgetMs: THIRTY_MINUTES_MS,
      onWaitStart: () => {
        announced += 1;
      },
      sleep,
    });

    expect(acquisition).toEqual({
      type: "completed",
      value: RAN,
      waitedMs: 0,
    });
    expect(attempts()).toBe(1);
    expect(pauses).toEqual([]);
    expect(announced).toBe(0);
  });

  test("retries on a fixed pause until the holder releases", async () => {
    const { run, attempts } = refusingRun(3);
    const { pauses, sleep } = recordingSleep();
    let announced = 0;

    const acquisition = await runWithReplayLease({
      run,
      waitBudgetMs: THIRTY_MINUTES_MS,
      onWaitStart: () => {
        announced += 1;
      },
      sleep,
    });

    expect(acquisition).toEqual({
      type: "completed",
      value: RAN,
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
    const { run, attempts } = refusingRun(Number.POSITIVE_INFINITY);
    const { pauses, sleep } = recordingSleep();
    const waitBudgetMs = 30_000;

    const acquisition = await runWithReplayLease({
      run,
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
    const { run, attempts } = refusingRun(Number.POSITIVE_INFINITY);
    const { pauses, sleep } = recordingSleep();
    let announced = 0;

    const acquisition = await runWithReplayLease({
      run,
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
