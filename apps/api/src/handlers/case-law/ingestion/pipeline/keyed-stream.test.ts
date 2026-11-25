import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { streamKeyedInOrder } from "./keyed-stream";

type Item = { keys: string[]; delayMs: number };

type Event =
  | { type: "start"; index: number; at: number }
  | { type: "end"; index: number; at: number };

const itemArbitrary = fc.record({
  keys: fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f"), {
    maxLength: 2,
  }),
  delayMs: fc.integer({ min: 0, max: 3 }),
});

/**
 * Let other operations run for `count` microtask turns: operations of
 * different lengths finish out of input order.
 */
const turns = async (count: number): Promise<void> => {
  for (let turn = 0; turn < count * 3; turn++) {
    await Promise.resolve();
  }
};

/** Run a stream, recording when each operation started and ended. */
const runStream = async ({
  items,
  limit,
  stopAfter,
  admitted = () => true,
}: {
  items: readonly Item[];
  limit: number;
  stopAfter?: number;
  admitted?: (started: number) => boolean;
}) => {
  const events: Event[] = [];
  let clock = 0;
  let started = 0;
  const yielded: number[] = [];
  let running = 0;
  let maxRunning = 0;
  for await (const { index, value } of streamKeyedInOrder({
    items,
    limit,
    keysOf: (item) => item.keys,
    admits: () => admitted(started),
    operation: async (item, position) => {
      started++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      events.push({ type: "start", index: position, at: clock++ });
      await turns(item.delayMs);
      events.push({ type: "end", index: position, at: clock++ });
      running--;
      return position * 10;
    },
  })) {
    expect(value).toBe(index * 10);
    yielded.push(index);
    if (stopAfter !== undefined && yielded.length >= stopAfter) {
      break;
    }
  }
  return { events, yielded, maxRunning, runningAfterClose: running };
};

const intervals = (events: readonly Event[]) => {
  const byIndex = new Map<number, { start: number; end: number }>();
  for (const event of events) {
    const interval = byIndex.get(event.index) ?? { start: -1, end: -1 };
    interval[event.type] = event.at;
    byIndex.set(event.index, interval);
  }
  return byIndex;
};

describe("streamKeyedInOrder", () => {
  test(
    "items sharing a key never overlap and run in input order",
    async () => {
      await assertProperty(
        "items sharing a key never overlap and run in input order",
        fc.asyncProperty(
          fc.array(itemArbitrary, { maxLength: 24 }),
          fc.integer({ min: 1, max: 6 }),
          async (items, limit) => {
            const { events, yielded, maxRunning } = await runStream({
              items,
              limit,
            });
            expect(yielded).toEqual(items.map((_, index) => index));
            expect(maxRunning).toBeLessThanOrEqual(limit);
            const ran = intervals(events);
            for (const [later, laterItem] of items.entries()) {
              for (const [earlier, earlierItem] of items
                .slice(0, later)
                .entries()) {
                if (
                  !laterItem.keys.some((key) => earlierItem.keys.includes(key))
                ) {
                  continue;
                }
                const first = ran.get(earlier);
                const second = ran.get(later);
                // The later item starts only after the earlier one ended.
                expect(first?.end ?? -1).toBeLessThan(second?.start ?? -1);
              }
            }
            const starts = events
              .filter((event) => event.type === "start")
              .map((event) => event.index);
            expect(starts).toEqual(items.map((_, index) => index));
          },
        ),
      );
    },
    propertyTestTimeout(60_000),
  );

  test(
    "a consumer that stops leaves an unstarted suffix and nothing running",
    async () => {
      await assertProperty(
        "a consumer that stops leaves an unstarted suffix and nothing running",
        fc.asyncProperty(
          fc.array(itemArbitrary, { minLength: 1, maxLength: 24 }),
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 1, max: 24 }),
          async (items, limit, stopAfter) => {
            const { events, yielded, runningAfterClose } = await runStream({
              items,
              limit,
              stopAfter,
            });
            expect(runningAfterClose).toBe(0);
            expect(yielded).toEqual(
              items
                .slice(0, Math.min(stopAfter, items.length))
                .map((_, i) => i),
            );
            const started = [
              ...new Set(
                events
                  .filter((event) => event.type === "start")
                  .map((event) => event.index),
              ),
            ];
            expect(started).toEqual(started.map((_, index) => index));
            const ended = events.filter((event) => event.type === "end");
            expect(ended).toHaveLength(started.length);
          },
        ),
      );
    },
    propertyTestTimeout(60_000),
  );

  test("an admission that turns false stops starting, not the started", async () => {
    const items: Item[] = Array.from({ length: 10 }, () => ({
      keys: [],
      delayMs: 1,
    }));
    const { yielded, events } = await runStream({
      items,
      limit: 4,
      admitted: (started) => started < 6,
    });
    expect(yielded).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events.filter((event) => event.type === "start")).toHaveLength(6);
  });

  test("an admission held while work runs is asked again when it settles", async () => {
    const items: Item[] = Array.from({ length: 5 }, () => ({
      keys: [],
      delayMs: 1,
    }));
    let settled = 0;
    const yielded: number[] = [];
    let running = 0;
    for await (const { index } of streamKeyedInOrder({
      items,
      limit: 4,
      keysOf: () => [],
      // One at a time: the gate opens only once the running one is taken.
      admits: () => running === 0 && yielded.length === settled,
      operation: async (item) => {
        running++;
        await turns(item.delayMs);
        running--;
        settled++;
        return 0;
      },
    })) {
      yielded.push(index);
    }
    expect(yielded).toEqual([0, 1, 2, 3, 4]);
  });
});
