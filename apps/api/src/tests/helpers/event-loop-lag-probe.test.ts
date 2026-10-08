import { expect, test } from "bun:test";

import { createEventLoopSlicer } from "@stll/concurrency/event-loop";
import { sleep } from "@stll/concurrency/sleep";

import { startEventLoopLagProbe } from "./event-loop-lag-probe";

/** Spins for `ms` of CPU time, however busy the machine is. */
const busyFor = (ms: number) => {
  const started = process.cpuUsage();
  while (process.cpuUsage(started).user < ms * 1000) {
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
