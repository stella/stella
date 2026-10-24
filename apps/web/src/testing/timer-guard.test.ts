import { expect, test } from "bun:test";

import {
  isLiveTimer,
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

test("the runtime reports a timer live only until it fires or any path ends it", async () => {
  const live = setTimeout(() => {}, 10_000);
  live.unref();
  expect(isLiveTimer(live)).toBe(true);
  clearTimeout(live);
  expect(isLiveTimer(live)).toBe(false);
  const fired = setTimeout(() => {}, 1);
  await Bun.sleep(10);
  expect(isLiveTimer(fired)).toBe(false);
  const checkEnd = (end: (timer: ReturnType<typeof setTimeout>) => void) => {
    const timeout = setTimeout(() => {}, 10_000);
    const interval = setInterval(() => {}, 10_000);
    end(timeout);
    end(interval);
    expect([isLiveTimer(timeout), isLiveTimer(interval)]).toEqual([
      false,
      false,
    ]);
  };
  for (const end of [
    (timer: ReturnType<typeof setTimeout>) => timer.close(),
    (timer: ReturnType<typeof setTimeout>) => timer[Symbol.dispose](),
    (timer: ReturnType<typeof setTimeout>) => clearInterval(timer),
  ]) {
    checkEnd(end);
  }
  expect(leaksAtTestEnd()).toEqual([]);
});

test("a timeout still pending when its test ends is cancelled and reported with its origin", async () => {
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
  const interval = setInterval(() => {
    ticks += 1;
  }, 1);
  const leaks = leaksAtTestEnd();
  expect(isLiveTimer(interval)).toBe(false);
  clearInterval(interval);
  const stopped = ticks;
  await Bun.sleep(10);
  expect(leaks).toHaveLength(1);
  expect(leaks.at(0)).toContain("interval still pending");
  expect(ticks).toBe(stopped);
});

test("a timeout its own callback refreshes stays live and is reported", async () => {
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
  await Bun.sleep(20);
  expect(runs).toBe(1);
});

test("timers that fire, or end by clear, close or dispose, are not leaks", async () => {
  const fired = Promise.withResolvers<undefined>();
  setTimeout(() => {
    fired.resolve(undefined);
  }, 1);
  clearTimeout(setTimeout(() => {}, 10_000));
  clearInterval(setInterval(() => {}, 10_000));
  setTimeout(() => {}, 10_000).close();
  setInterval(() => {}, 10_000).close();
  {
    using disposedTimeout = setTimeout(() => {}, 10_000);
    using disposedInterval = setInterval(() => {}, 10_000);
    expect(isLiveTimer(disposedTimeout)).toBe(true);
    expect(isLiveTimer(disposedInterval)).toBe(true);
  }
  await fired.promise;
  expect(leaksAtTestEnd()).toEqual([]);
});
