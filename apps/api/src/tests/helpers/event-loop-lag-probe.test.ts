import { expect, test } from "bun:test";

import {
  createEventLoopSlicer,
  nextMacrotask,
} from "@stll/concurrency/event-loop";
import { sleep } from "@stll/concurrency/sleep";

import {
  asRoundTrip,
  expectEventLoopResponsive,
  startEventLoopLagProbe,
} from "./event-loop-lag-probe";

/** Spins for `ms` of CPU time, however busy the machine is. */
const busyFor = (ms: number) => {
  const started = process.threadCpuUsage();
  while (true) {
    const { user, system } = process.threadCpuUsage(started);
    if (user + system >= ms * 1000) {
      return;
    }
    // Synchronous work that holds the loop.
  }
};

test("the probe reports a synchronous span that holds the loop", async () => {
  const probe = startEventLoopLagProbe();
  await sleep(10);
  busyFor(150);
  const report = await probe.stop();
  expect(report.maxBlockedMs).toBeGreaterThan(100);
  expect(report.longestSpans.at(0)?.blockedMs).toBe(report.maxBlockedMs);
});

test("stopping before the first sample still measures the final CPU slice", async () => {
  const probe = startEventLoopLagProbe();
  busyFor(150);
  expect((await probe.stop()).maxBlockedMs).toBeGreaterThanOrEqual(150);
});

test("the probe counts a microtask-only chain as blocking", async () => {
  const probe = startEventLoopLagProbe();
  await sleep(10);
  const chain = async (left: number): Promise<void> => {
    if (left === 0) {
      return;
    }
    busyFor(10);
    await Promise.resolve();
    await chain(left - 1);
  };
  await chain(15);
  expect((await probe.stop()).maxBlockedMs).toBeGreaterThan(100);
});

test("work that gives way through the slicer stays within budget", async () => {
  const probe = startEventLoopLagProbe();
  const pause = createEventLoopSlicer();
  for (let step = 0; step < 150; step += 1) {
    busyFor(1);
    await pause();
  }
  expect((await probe.stop()).maxBlockedMs).toBeLessThan(100);
});

for (const waitMs of [0, 100, 250]) {
  test(`excluded work waiting ${waitMs} ms cannot erase subsequent CPU`, async () => {
    const waitWord = new Int32Array(new SharedArrayBuffer(4));
    const probe = startEventLoopLagProbe();
    await asRoundTrip(async () => {
      // Wait without a timer turn: excluded waiting and later CPU share a slice.
      Atomics.wait(waitWord, 0, 0, waitMs);
      busyFor(10);
    });
    busyFor(150);
    const report = await probe.stop();
    expect(report.maxBlockedMs).toBeGreaterThanOrEqual(150);
    expect(() => expectEventLoopResponsive(report, { budgetMs: 100 })).toThrow(
      "the event loop was blocked for longer than 100 ms",
    );
  });
}

test("excluded waiting and query CPU do not count as blocking", async () => {
  const probe = startEventLoopLagProbe();
  await asRoundTrip(async () => {
    await sleep(100);
    busyFor(150);
  });
  expectEventLoopResponsive(await probe.stop(), { budgetMs: 100 });
});

test("nested excluded operations subtract their CPU only once", async () => {
  const probe = startEventLoopLagProbe();
  await asRoundTrip(async () => {
    busyFor(10);
    await asRoundTrip(async () => {
      busyFor(10);
    });
    busyFor(10);
  });
  busyFor(150);
  expect((await probe.stop()).maxBlockedMs).toBeGreaterThanOrEqual(150);
});

test("each macrotask yield ends a CPU slice", async () => {
  const probe = startEventLoopLagProbe();
  for (let step = 0; step < 30; step += 1) {
    busyFor(5);
    await nextMacrotask();
  }
  expectEventLoopResponsive(await probe.stop(), { budgetMs: 100 });
});

test("an excluded operation that only waits does not count as blocking", async () => {
  const probe = startEventLoopLagProbe();
  await asRoundTrip(async () => await sleep(150));
  expectEventLoopResponsive(await probe.stop(), { budgetMs: 100 });
});
