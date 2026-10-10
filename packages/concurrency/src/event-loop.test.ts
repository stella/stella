import { expect, test } from "bun:test";

import { createEventLoopSlicer, nextMacrotask } from "./event-loop";

test("nextMacrotask continues after queued macrotasks, not as a microtask", async () => {
  const order: string[] = [];
  setImmediate(() => {
    order.push("queued macrotask");
  });
  await Promise.resolve();
  order.push("microtask");
  await nextMacrotask();
  order.push("after nextMacrotask");
  expect(order).toEqual([
    "microtask",
    "queued macrotask",
    "after nextMacrotask",
  ]);
});

test("the slicer yields only once a slice has used its budget", async () => {
  let clock = 0;
  const pause = createEventLoopSlicer({ sliceMs: 10, now: () => clock });
  let queuedRan = false;
  setImmediate(() => {
    queuedRan = true;
  });
  clock = 9;
  await pause();
  expect(queuedRan).toBe(false);
  clock = 10;
  await pause();
  expect(queuedRan).toBe(true);
});
