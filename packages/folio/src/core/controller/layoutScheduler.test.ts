import { describe, expect, test } from "bun:test";

import {
  createLayoutScheduler,
  type LayoutRunOptions,
  type SchedulerClock,
} from "./layoutScheduler";

type TestState = { id: number };

const makeFakeClock = () => {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();

  const clock: SchedulerClock = {
    now: () => time,
    setTimer: (cb) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  };

  const fireAll = (map: Map<number, () => void>): void => {
    const callbacks = [...map.values()];
    map.clear();
    for (const run of callbacks) {
      run();
    }
  };

  return {
    clock,
    advance: (ms: number) => {
      time += ms;
    },
    fireTimers: () => fireAll(timers),
    fireFrames: () => fireAll(frames),
    pendingTimers: () => timers.size,
    pendingFrames: () => frames.size,
  };
};

describe("layoutScheduler", () => {
  test("coalesces a burst into one layout run with the latest state", () => {
    const fc = makeFakeClock();
    const runs: TestState[] = [];
    const scheduler = createLayoutScheduler<TestState>({
      runLayout: (state) => {
        runs.push(state);
      },
      debounceMs: 32,
      maxDelayMs: 96,
      clock: fc.clock,
    });

    scheduler.schedule({ id: 1 }, null);
    scheduler.schedule({ id: 2 }, null);
    scheduler.schedule({ id: 3 }, null);

    // One armed debounce timer, nothing run yet.
    expect(fc.pendingTimers()).toBe(1);
    expect(runs).toHaveLength(0);

    fc.fireTimers(); // debounce elapses -> schedules a frame
    fc.fireFrames(); // frame runs layout once, with the latest state

    expect(runs).toEqual([{ id: 3 }]);
  });

  test("passes the merged dirty range through to runLayout", () => {
    const fc = makeFakeClock();
    const optionsSeen: LayoutRunOptions[] = [];
    const scheduler = createLayoutScheduler<TestState>({
      runLayout: (_state, options) => {
        optionsSeen.push(options);
      },
      debounceMs: 32,
      maxDelayMs: 96,
      clock: fc.clock,
    });

    scheduler.schedule({ id: 1 }, { from: 10, to: 20 });
    scheduler.schedule({ id: 2 }, { from: 30, to: 40 });
    fc.fireTimers();
    fc.fireFrames();

    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]?.reason).toBe("transaction");
    // mergeDirtyRanges widens to cover both edits.
    expect(optionsSeen[0]?.dirtyRange).toEqual({ from: 10, to: 40 });
  });

  test("exceeding maxDelay flushes with zero debounce", () => {
    const fc = makeFakeClock();
    const runs: TestState[] = [];
    const scheduler = createLayoutScheduler<TestState>({
      runLayout: (state) => {
        runs.push(state);
      },
      debounceMs: 32,
      maxDelayMs: 96,
      clock: fc.clock,
    });

    scheduler.schedule({ id: 1 }, null);
    fc.advance(100); // past maxDelay since the first edit
    scheduler.schedule({ id: 2 }, null); // re-arms with delay 0
    fc.fireTimers();
    fc.fireFrames();

    expect(runs).toEqual([{ id: 2 }]);
  });

  test("dispose cancels a pending run", () => {
    const fc = makeFakeClock();
    const runs: TestState[] = [];
    const scheduler = createLayoutScheduler<TestState>({
      runLayout: (state) => {
        runs.push(state);
      },
      debounceMs: 32,
      maxDelayMs: 96,
      clock: fc.clock,
    });

    scheduler.schedule({ id: 1 }, null);
    scheduler.dispose();
    fc.fireTimers();
    fc.fireFrames();

    expect(runs).toHaveLength(0);
    expect(fc.pendingTimers()).toBe(0);
    expect(fc.pendingFrames()).toBe(0);
  });
});
