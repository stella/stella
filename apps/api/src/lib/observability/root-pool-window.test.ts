import { afterEach, describe, expect, test } from "bun:test";

import {
  emitEventLoopDelayMetric,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { createRootPoolWindow } from "@/api/lib/observability/root-pool-window";

afterEach(resetMetricLineSinkForTesting);

const observedSnapshot = {
  status: "observed",
  size: 1,
  inUse: 0,
  idle: 1,
} as const;

const fakeClock = () => {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

const recordSample = (
  window: ReturnType<typeof createRootPoolWindow>,
  clock: ReturnType<typeof fakeClock>,
  waitMs: number,
) => {
  const start = window.requested();
  expect(typeof start).toBe("number");
  clock.advance(waitMs);
  window.acquired(start);
  window.released();
  // Move to the next sampled request without allocating timer handles.
  for (let index = 1; index < 64; index += 1) {
    expect(window.requested()).toBeNull();
    window.acquired(null);
    window.released();
  }
};

describe("root pool interval aggregation", () => {
  test("reports nearest-rank percentile bounds and exact sampled max, then resets", () => {
    const clock = fakeClock();
    const window = createRootPoolWindow({ now: clock.now, random: () => 0 });
    for (let value = 20; value > 0; value -= 1) {
      recordSample(window, clock, value);
    }
    expect(window.flush(8, observedSnapshot)).toEqual({
      size: 1,
      max: 8,
      inUse: 0,
      idle: 1,
      snapshotStatus: "observed",
      acquisitionScope: "transactions",
      inUseTransactions: 0,
      waitingRequests: 0,
      waitingRequestsPeak: 1,
      inUseTransactionsPeak: 1,
      waitP50Ms: 10,
      waitP95Ms: 19,
      waitMaxMs: 20,
      waitSamples: 20,
      acquisitionFailures: 0,
      intervalMs: 210,
      sampleEvery: 64,
    });
    clock.advance(60_000);
    expect(window.flush(8, observedSnapshot)).toEqual({
      size: 1,
      max: 8,
      inUse: 0,
      idle: 1,
      snapshotStatus: "observed",
      acquisitionScope: "transactions",
      inUseTransactions: 0,
      waitingRequests: 0,
      waitingRequestsPeak: 0,
      inUseTransactionsPeak: 0,
      waitP50Ms: null,
      waitP95Ms: null,
      waitMaxMs: null,
      waitSamples: 0,
      acquisitionFailures: 0,
      intervalMs: 60_000,
      sampleEvery: 64,
    });
    recordSample(window, clock, 0);
    expect(window.flush(8, observedSnapshot).waitP95Ms).toBe(0);
  });

  test("keeps live counts across a report and clears failed acquisitions", () => {
    const clock = fakeClock();
    const window = createRootPoolWindow({ now: clock.now, random: () => 0 });
    const start = window.requested();
    expect(window.flush(2, observedSnapshot).waitingRequests).toBe(1);
    clock.advance(7);
    window.acquired(start);
    window.requested();
    window.failed();
    expect(window.flush(2, observedSnapshot)).toMatchObject({
      size: 1,
      inUseTransactions: 1,
      waitingRequests: 0,
      acquisitionFailures: 1,
      waitP50Ms: 7,
      waitSamples: 1,
    });
    window.released();
    expect(window.flush(2, observedSnapshot)).toMatchObject({
      inUseTransactions: 0,
      waitingRequests: 0,
      acquisitionFailures: 0,
    });
  });

  test("keeps unavailable pool counts distinct from zero and still reports the acquisition window", () => {
    const clock = fakeClock();
    const window = createRootPoolWindow({ now: clock.now, random: () => 0 });
    recordSample(window, clock, 12);
    expect(
      window.flush(8, {
        status: "unavailable",
        size: null,
        inUse: null,
        idle: null,
      }),
    ).toMatchObject({
      size: null,
      inUse: null,
      idle: null,
      snapshotStatus: "unavailable",
      waitP50Ms: 12,
      waitP95Ms: 12,
      waitMaxMs: 12,
      waitSamples: 1,
    });
  });

  test("returns only primitive tokens and reads the clock only on sampled requests", () => {
    let calls = 0;
    let draws = 0;
    const window = createRootPoolWindow({
      now: () => {
        calls += 1;
        return 0;
      },
      random: () => {
        draws += 1;
        return 0;
      },
    });
    expect(calls).toBe(1);
    for (let index = 0; index < 128; index += 1) {
      const token = window.requested();
      expect(token === null || typeof token === "number").toBe(true);
      window.acquired(token);
      window.released();
    }
    expect(calls).toBe(5);
    expect(draws).toBe(2);
    expect(window.flush(8, observedSnapshot).waitSamples).toBe(2);
  });

  test("fresh sampling phases cover queued positions in periodic batches", () => {
    let time = 0;
    let phase = 0;
    let draws = 0;
    const window = createRootPoolWindow({
      now: () => time,
      random: () => {
        draws += 1;
        return (phase + 0.5) / 64;
      },
    });
    for (phase = 0; phase < 64; phase += 1) {
      const tokens: (number | null)[] = [];
      time = phase * 1000;
      for (let position = 0; position < 64; position += 1) {
        tokens.push(window.requested());
      }
      expect(tokens.filter((token) => token !== null)).toHaveLength(1);
      expect(tokens.at(phase)).toBe(time);
      for (const [position, token] of tokens.entries()) {
        time = phase * 1000 + position;
        window.acquired(token);
        window.released();
      }
    }
    expect(draws).toBe(64);
    expect(window.flush(8, observedSnapshot)).toMatchObject({
      waitSamples: 64,
      waitP50Ms: 31,
      waitP95Ms: 60,
      waitMaxMs: 63,
    });
  });

  test("bounds fractional waits and preserves long waits in the overflow bucket", () => {
    const clock = fakeClock();
    const window = createRootPoolWindow({ now: clock.now, random: () => 0 });
    recordSample(window, clock, 1.25);
    recordSample(window, clock, 70_000.5);
    expect(window.flush(8, observedSnapshot)).toMatchObject({
      waitP50Ms: 2,
      waitP95Ms: 70_000.5,
      waitMaxMs: 70_000.5,
    });
  });
});

test("pool fields extend one existing record without declaring new metrics or dimensions", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  const window = createRootPoolWindow({ now: () => 0, random: () => 0 });
  const report = window.flush(8, observedSnapshot);
  emitEventLoopDelayMetric({ maxMs: 12, p99Ms: 10, rootPool: report });
  expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
    {
      _aws: {
        Timestamp: expect.any(Number),
        CloudWatchMetrics: [
          {
            Namespace: "Stella/Api",
            Dimensions: [[]],
            Metrics: [
              { Name: "EventLoopDelayMax", Unit: "Milliseconds" },
              { Name: "EventLoopDelayP99", Unit: "Milliseconds" },
            ],
          },
        ],
      },
      rootPool: report,
      EventLoopDelayMax: 12,
      EventLoopDelayP99: 10,
    },
  ]);
});
