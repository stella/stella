import { panic } from "better-result";

import { Temporal } from "@stll/time";

/**
 * The time source code under test reads. Production passes `systemClock`;
 * tests pass a `createTestClock()` and move time explicitly, so no assertion
 * depends on how fast the machine happens to be.
 */
export type Clock = {
  /** Wall-clock epoch milliseconds. */
  now: () => number;
  /** Monotonic milliseconds for measuring durations; never moves backwards. */
  monotonic: () => number;
  /** Resolves once `milliseconds` have passed on this clock. */
  sleep: (milliseconds: number, options?: SleepOptions) => Promise<void>;
};

export type SleepOptions = { signal?: AbortSignal };

export type TestClock = Clock & {
  /**
   * Moves both clocks forward, waking each due sleeper in deadline order and
   * letting the work it schedules run before the next one wakes.
   */
  advance: (milliseconds: number) => Promise<void>;
  /** Advances to the earliest pending sleeper; false when none is pending. */
  advanceToNext: () => Promise<boolean>;
  /** Jumps the wall clock (a clock change); the monotonic clock stays put. */
  setTime: (epochMilliseconds: number) => void;
  /** Sleepers that have not woken or been aborted yet. */
  pendingSleepers: () => number;
};

const assertDuration = (milliseconds: number, what: string) => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    panic(`${what} must be a finite, non-negative number of milliseconds`);
  }
};

/** The longest delay a platform timer holds before it overflows. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

const abortableTimeout = async (
  milliseconds: number,
  { signal }: SleepOptions = {},
): Promise<void> => {
  if (signal?.aborted) {
    signal.throwIfAborted();
  }
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  // Timers overflow above MAX_TIMER_MS and fire at once, so a longer sleep
  // waits in chunks until the whole duration has passed.
  const wait = (remaining: number) => {
    const chunk = Math.min(remaining, MAX_TIMER_MS);
    // kit-allow: the system clock is the one owner of real timers.
    timer = setTimeout(() => {
      if (remaining > chunk) {
        wait(remaining - chunk);
        return;
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, chunk);
  };
  wait(milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
};

/** The real clock. The only place in the kit that reads ambient time. */
export const systemClock: Clock = {
  // kit-allow: the system clock is the one owner of ambient time.
  now: () => Temporal.Now.instant().epochMilliseconds,
  // kit-allow: the system clock is the one owner of ambient time.
  monotonic: () => performance.now(),
  sleep: async (milliseconds, options) => {
    assertDuration(milliseconds, "sleep");
    return abortableTimeout(milliseconds, options);
  },
};

/** A fixed, readable default start so failures print stable timestamps. */
export const TEST_CLOCK_START = Temporal.Instant.from(
  "2026-01-01T09:00:00Z",
).epochMilliseconds;

type Sleeper = {
  dueAt: number;
  sequence: number;
  wake: () => void;
};

// A macrotask turn: lets the promise chain a woken sleeper resumes run to its
// next await (often a new sleep) before the clock moves again. No time passes.
const settle = async () =>
  new Promise<undefined>((resolve) => {
    setImmediate(() => resolve(undefined));
  });

export const createTestClock = ({
  start = TEST_CLOCK_START,
}: { start?: number } = {}): TestClock => {
  let wall = start;
  let mono = 0;
  let sequence = 0;
  let advancing = false;
  const sleepers = new Set<Sleeper>();

  const earliest = (): Sleeper | undefined => {
    let next: Sleeper | undefined;
    for (const sleeper of sleepers) {
      if (
        next === undefined ||
        sleeper.dueAt < next.dueAt ||
        (sleeper.dueAt === next.dueAt && sleeper.sequence < next.sequence)
      ) {
        next = sleeper;
      }
    }
    return next;
  };

  const moveTo = (target: number) => {
    wall += target - mono;
    mono = target;
  };

  const advanceTo = async (target: number) => {
    if (advancing) {
      panic("TestClock.advance is already running; await the previous call");
    }
    advancing = true;
    try {
      await settle();
      for (;;) {
        const next = earliest();
        if (next === undefined || next.dueAt > target) {
          break;
        }
        sleepers.delete(next);
        moveTo(Math.max(mono, next.dueAt));
        next.wake();
        await settle();
      }
      moveTo(Math.max(mono, target));
    } finally {
      advancing = false;
    }
  };

  return {
    now: () => wall,
    monotonic: () => mono,
    sleep: async (milliseconds, { signal } = {}) => {
      assertDuration(milliseconds, "sleep");
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      const { promise, resolve, reject } = Promise.withResolvers<undefined>();
      const onAbort = () => {
        sleepers.delete(sleeper);
        reject(signal?.reason);
      };
      const sleeper: Sleeper = {
        dueAt: mono + milliseconds,
        sequence: sequence++,
        wake: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(undefined);
        },
      };
      sleepers.add(sleeper);
      signal?.addEventListener("abort", onAbort, { once: true });
      return promise;
    },
    advance: async (milliseconds) => {
      assertDuration(milliseconds, "advance");
      return advanceTo(mono + milliseconds);
    },
    advanceToNext: async () => {
      const next = earliest();
      if (next === undefined) {
        return false;
      }
      await advanceTo(next.dueAt);
      return true;
    },
    setTime: (epochMilliseconds) => {
      if (!Number.isFinite(epochMilliseconds)) {
        panic("setTime needs a finite epoch in milliseconds");
      }
      wall = epochMilliseconds;
    },
    pendingSleepers: () => sleepers.size,
  };
};
