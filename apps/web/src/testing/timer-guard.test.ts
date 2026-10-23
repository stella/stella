import { expect, test } from "bun:test";

import {
  markTimerTestEnded,
  markTimerTestStarted,
  takeLeakedTimers,
} from "@/testing/timer-guard";

// Each case ends its own "test" by hand so the leak lands here, not in the
// preload's hook, then starts the next one so the real hooks stay balanced.
const leaksAtTestEnd = () => {
  markTimerTestEnded();
  const leaks = takeLeakedTimers();
  markTimerTestStarted();
  return leaks;
};

test("a timeout still pending when its test ends is cleared and reported with its origin", async () => {
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 5);
  const leaks = leaksAtTestEnd();
  expect(leaks).toHaveLength(1);
  expect(leaks.at(0)).toContain("timeout still pending");
  expect(leaks.at(0)).toContain("timer-guard.test.ts");
  await Bun.sleep(20);
  expect(fired).toBe(false);
});

test("an interval left running is stopped and reported", async () => {
  let ticks = 0;
  setInterval(() => {
    ticks += 1;
  }, 1);
  const leaks = leaksAtTestEnd();
  const stopped = ticks;
  await Bun.sleep(10);
  expect(leaks).toHaveLength(1);
  expect(leaks.at(0)).toContain("interval still pending");
  expect(ticks).toBe(stopped);
});

test("a timeout its own callback refreshes stays pending and is reported", async () => {
  let runs = 0;
  const firstRun = Promise.withResolvers<undefined>();
  const handle = setTimeout(() => {
    runs += 1;
    handle.refresh();
    firstRun.resolve(undefined);
  }, 1);
  await firstRun.promise;
  const leaks = leaksAtTestEnd();
  expect(leaks).toHaveLength(1);
  expect(leaks.at(0)).toContain("timeout still pending");
  await Bun.sleep(20);
  expect(runs).toBe(1);
});

test("timers that fire or are cleared before the test ends are not leaks", async () => {
  const fired = Promise.withResolvers<undefined>();
  setTimeout(() => {
    fired.resolve(undefined);
  }, 1);
  const cleared = setTimeout(() => {}, 10_000);
  clearTimeout(cleared);
  const interval = setInterval(() => {}, 10_000);
  clearInterval(interval);
  const byId = setTimeout(() => {}, 10_000);
  clearTimeout(Number(byId));
  await fired.promise;
  expect(leaksAtTestEnd()).toEqual([]);
});
