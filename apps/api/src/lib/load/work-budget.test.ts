import { expect, jest, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createWorkBudget, type WorkBudgetResult } from "./work-budget";

test("an oversize item runs alone and a large waiter keeps FIFO priority", async () => {
  const budget = createWorkBudget({
    slots: 2,
    bytes: 10,
    maxWaiters: 3,
    maxWaitMs: 1000,
  });
  const first = await budget.acquire({ bytes: 5 });
  expect(first.type).toBe("admitted");
  const largePromise = budget.acquire({ bytes: 9 });
  const smallPromise = budget.acquire({ bytes: 2 });
  if (first.type !== "admitted") {
    throw new Error("expected admission");
  }
  first.release();
  const large = await largePromise;
  expect(large.type).toBe("admitted");
  expect(budget.stats().queued).toBe(1);
  if (large.type !== "admitted") {
    throw new Error("expected admission");
  }
  large.release();
  const small = await smallPromise;
  if (small.type !== "admitted") {
    throw new Error("expected admission");
  }
  small.release();

  const oversize = await budget.acquire({ bytes: 20 });
  expect(oversize.type).toBe("admitted");
  if (oversize.type === "admitted") {
    oversize.release();
  }
});

test("queue bounds, timeout retry, abort removal, and double release are enforced", async () => {
  const budget = createWorkBudget({
    slots: 1,
    bytes: 10,
    maxWaiters: 1,
    maxWaitMs: 10,
  });
  const held = await budget.acquire({});
  const controller = new AbortController();
  const waiting = budget.acquire({ signal: controller.signal });
  const full = await budget.acquire({});
  expect(full).toEqual({ type: "refused", reason: "busy", retryAfterMs: 10 });
  controller.abort();
  expect(await waiting).toEqual({
    type: "refused",
    reason: "aborted",
    retryAfterMs: 0,
  });
  const timeout = budget.acquire({});
  expect(await timeout).toEqual({
    type: "refused",
    reason: "busy",
    retryAfterMs: 10,
  });
  if (held.type !== "admitted") {
    throw new Error("expected admission");
  }
  held.release();
  expect(() => held.release()).toThrow("released twice");
});

test("memory pressure closes the queue and determines its timeout refusal", async () => {
  let memoryOpen = true;
  const budget = createWorkBudget({
    slots: 1,
    bytes: 10,
    maxWaiters: 2,
    maxWaitMs: 10,
    memoryOpen: () => memoryOpen,
  });
  const held = await budget.acquire({});
  const waiting = budget.acquire({});
  memoryOpen = false;
  if (held.type !== "admitted") {
    throw new Error("expected admission");
  }
  held.release();
  expect(await waiting).toEqual({
    type: "refused",
    reason: "memory",
    retryAfterMs: 10,
  });
  expect(await budget.acquire({})).toEqual({
    type: "refused",
    reason: "memory",
    retryAfterMs: 10,
  });
});

test("a queue held back by memory pressure runs once memory recovers", async () => {
  let memoryOpen = true;
  const budget = createWorkBudget({
    slots: 1,
    bytes: 10,
    maxWaiters: 1,
    maxWaitMs: 1000,
    memoryOpen: () => memoryOpen,
    memoryRecheckMs: 5,
  });
  const held = await budget.acquire({});
  const waiting = budget.acquire({});
  memoryOpen = false;
  if (held.type !== "admitted") {
    throw new Error("expected admission");
  }
  held.release();
  expect(budget.stats()).toEqual({ inFlight: 0, queued: 1, bytesInFlight: 0 });
  memoryOpen = true;
  const admitted = await waiting;
  expect(admitted.type).toBe("admitted");
  if (admitted.type === "admitted") {
    admitted.release();
  }
});

const SLOT_CAPACITY = 3;
const BYTE_CAPACITY = 10;

const budgetStep = fc.oneof(
  fc.record({
    type: fc.constant("acquire"),
    slots: fc.integer({ min: 1, max: 2 }),
    bytes: fc.integer({ min: 0, max: 14 }),
    abort: fc.constantFrom("none", "before", "while-queued"),
  }),
  fc.record({ type: fc.constant("release"), pick: fc.nat() }),
  fc.record({ type: fc.constant("memory"), open: fc.boolean() }),
  fc.record({ type: fc.constant("tick") }),
);

type Held = { slots: number; bytes: number; release: () => void };
type Tracked = { held: Held[] };

const trackAcquire = async ({
  tracked,
  slots,
  bytes,
  result,
}: {
  tracked: Tracked;
  slots: number;
  bytes: number;
  result: Promise<WorkBudgetResult>;
}) => {
  const settled = await result;
  if (settled.type === "admitted") {
    tracked.held.push({ slots, bytes, release: settled.release });
  }
};

test("overlapping holds, aborts, timeouts and memory pressure keep exact accounting", async () => {
  await assertProperty(
    "overlapping holds, aborts, timeouts and memory pressure keep exact accounting",
    fc.asyncProperty(fc.array(budgetStep, { maxLength: 30 }), async (steps) => {
      jest.useFakeTimers();
      try {
        let memoryOpen = true;
        const budget = createWorkBudget({
          slots: SLOT_CAPACITY,
          bytes: BYTE_CAPACITY,
          maxWaiters: 4,
          maxWaitMs: 2,
          memoryOpen: () => memoryOpen,
          memoryRecheckMs: 1,
        });
        const tracked: Tracked = { held: [] };
        const acquisitions: Promise<void>[] = [];
        const expectExactAccounting = () => {
          const stats = budget.stats();
          expect(stats.inFlight).toBe(
            tracked.held.reduce((sum, item) => sum + item.slots, 0),
          );
          expect(stats.bytesInFlight).toBe(
            tracked.held.reduce((sum, item) => sum + item.bytes, 0),
          );
          // Only a single item admitted while the pool was idle may exceed it.
          expect(
            tracked.held.length <= 1 ||
              (stats.inFlight <= SLOT_CAPACITY &&
                stats.bytesInFlight <= BYTE_CAPACITY),
          ).toBe(true);
        };

        for (const step of steps) {
          switch (step.type) {
            case "acquire": {
              const controller = new AbortController();
              if (step.abort === "before") {
                controller.abort();
              }
              acquisitions.push(
                trackAcquire({
                  tracked,
                  slots: step.slots,
                  bytes: step.bytes,
                  result: budget.acquire({
                    slots: step.slots,
                    bytes: step.bytes,
                    signal: controller.signal,
                  }),
                }),
              );
              if (step.abort === "while-queued") {
                controller.abort();
              }
              break;
            }
            case "release": {
              const index = step.pick % Math.max(tracked.held.length, 1);
              const [item] = tracked.held.splice(index, 1);
              item?.release();
              break;
            }
            case "memory":
              memoryOpen = step.open;
              break;
            case "tick":
              jest.advanceTimersByTime(3);
              break;
            default:
              step satisfies never;
          }
          // Queue resolution, acquire's returned promise, and the tracking
          // continuation each enqueue a microtask; no clock progress is needed.
          for (let continuation = 0; continuation < 3; continuation += 1) {
            await Promise.resolve();
          }
          expectExactAccounting();
        }

        memoryOpen = true;
        for (const item of tracked.held.splice(0)) {
          item.release();
        }
        // Every remaining queue request either receives a released slot or
        // reaches its two-millisecond deadline under the controlled clock.
        jest.advanceTimersByTime(3);
        await Promise.all(acquisitions);
        expectExactAccounting();
        for (const item of tracked.held.splice(0)) {
          item.release();
        }
        expect(budget.stats()).toEqual({
          inFlight: 0,
          queued: 0,
          bytesInFlight: 0,
        });
      } finally {
        jest.useRealTimers();
      }
    }),
    { numRuns: 60 },
  );
});
