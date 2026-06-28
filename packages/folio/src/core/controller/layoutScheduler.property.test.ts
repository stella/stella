/**
 * Property-based tests for the layout scheduler's core invariant: any burst of
 * schedule() calls that lands inside the coalescing window collapses to exactly
 * one layout run, carrying the most-recent state and the merged dirty range of
 * the whole burst. This is the guarantee that a typing storm paints once.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { createLayoutScheduler, type SchedulerClock } from "./layoutScheduler";

type BurstItem = {
  id: number;
  dirty: { from: number; to: number } | null;
};

const makeFakeClock = () => {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();

  const clock: SchedulerClock = {
    now: () => 0,
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
    fireTimers: () => fireAll(timers),
    fireFrames: () => fireAll(frames),
  };
};

const burstItem: fc.Arbitrary<BurstItem> = fc.record({
  id: fc.integer(),
  dirty: fc.option(
    fc
      .record({ from: fc.nat(1000), len: fc.nat(1000) })
      .map(({ from, len }) => ({ from, to: from + len })),
    { nil: null },
  ),
});

describe("layoutScheduler (properties)", () => {
  test("a coalesced burst runs layout once, with the last state and merged range", () => {
    fc.assert(
      fc.property(
        fc.array(burstItem, { minLength: 1, maxLength: 40 }),
        (burst) => {
          const fake = makeFakeClock();
          const runs: {
            id: number;
            dirty: { from: number; to: number } | undefined;
          }[] = [];
          const scheduler = createLayoutScheduler<{ id: number }>({
            runLayout: (state, options) => {
              runs.push({ id: state.id, dirty: options.dirtyRange });
            },
            debounceMs: 32,
            maxDelayMs: 96,
            clock: fake.clock,
          });

          // Whole burst scheduled at t=0 (now() is fixed at 0), so nothing
          // exceeds maxDelay — it must coalesce into a single pass.
          for (const item of burst) {
            scheduler.schedule({ id: item.id }, item.dirty);
          }
          fake.fireTimers(); // debounce elapses -> arms one frame
          fake.fireFrames(); // frame runs the single layout

          expect(runs).toHaveLength(1);
          expect(runs[0]?.id).toBe(burst.at(-1)?.id);

          let merged: { from: number; to: number } | null = null;
          for (const item of burst) {
            if (!item.dirty) {
              continue;
            }
            merged = merged
              ? {
                  from: Math.min(merged.from, item.dirty.from),
                  to: Math.max(merged.to, item.dirty.to),
                }
              : { ...item.dirty };
          }

          if (merged) {
            expect(runs[0]?.dirty).toEqual(merged);
          } else {
            expect(runs[0]?.dirty).toBeUndefined();
          }
        },
      ),
    );
  });

  test("dispose before the frame fires cancels the run entirely", () => {
    fc.assert(
      fc.property(
        fc.array(burstItem, { minLength: 1, maxLength: 40 }),
        (burst) => {
          const fake = makeFakeClock();
          let runCount = 0;
          const scheduler = createLayoutScheduler<{ id: number }>({
            runLayout: () => {
              runCount += 1;
            },
            debounceMs: 32,
            maxDelayMs: 96,
            clock: fake.clock,
          });

          for (const item of burst) {
            scheduler.schedule({ id: item.id }, item.dirty);
          }
          scheduler.dispose();
          fake.fireTimers();
          fake.fireFrames();

          expect(runCount).toBe(0);
        },
      ),
    );
  });
});
