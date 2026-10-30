import { expect, test } from "bun:test";

import {
  monitorStagingReadiness,
  type ReadinessSource,
} from "./staging-proof-readiness";

const fakeClock = () => {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (durationMs: number) => {
      waits.push(durationMs);
      time += durationMs;
    },
    advance: (durationMs: number) => {
      time += durationMs;
    },
    waits,
  };
};

const timing = {
  deadlineMs: 100,
  intervalMs: 30,
  readTimeoutMs: 20,
};

test("healthy proof monitoring performs a final readiness check", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let reads = 0;
  const outcome = await monitorStagingReadiness({
    ...timing,
    ...clock,
    signal: controller.signal,
    read: async () => {
      reads += 1;
      if (reads === 2) {
        controller.abort();
      }
      return { status: "ready" };
    },
  });
  expect(outcome).toEqual({ status: "ready" });
  expect(reads).toBe(3);
  expect(clock.waits).toEqual([30]);
});

test("a sampled interruption remains interrupted after readiness recovers", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let reads = 0;
  const read: ReadinessSource = async () => {
    reads += 1;
    return { status: reads === 2 ? "not-ready" : "ready" };
  };
  const outcome = await monitorStagingReadiness({
    ...timing,
    ...clock,
    signal: controller.signal,
    read,
  });
  expect(reads).toBe(2);
  expect(await read({ timeoutMs: timing.readTimeoutMs })).toEqual({
    status: "ready",
  });
  expect(outcome).toEqual({ status: "environment-interrupted" });
});

test("a failed final sample marks the proof interrupted", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const outcome = await monitorStagingReadiness({
    ...timing,
    ...clock,
    signal: controller.signal,
    read: async () => {
      if (controller.signal.aborted) {
        return { status: "not-ready" };
      }
      controller.abort();
      return { status: "ready" };
    },
  });
  expect(outcome).toEqual({ status: "environment-interrupted" });
});

test("monitoring has a bounded lifetime even when readiness stays healthy", async () => {
  const clock = fakeClock();
  const timeouts: number[] = [];
  const outcome = await monitorStagingReadiness({
    ...timing,
    ...clock,
    signal: new AbortController().signal,
    read: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      return { status: "ready" };
    },
  });
  expect(outcome).toEqual({ status: "environment-interrupted" });
  expect(clock.now()).toBe(timing.deadlineMs);
  expect(timeouts).toEqual([20, 20, 20, 10]);
});

test("expired monitors never start a readiness read", async () => {
  const clock = fakeClock();
  let reads = 0;
  const options = {
    ...timing,
    ...clock,
    deadlineMs: 0,
    read: async () => {
      reads += 1;
      return { status: "ready" } as const;
    },
  };
  expect(
    await monitorStagingReadiness({
      ...options,
      signal: new AbortController().signal,
    }),
  ).toEqual({ status: "environment-interrupted" });
  expect(reads).toBe(0);
});
