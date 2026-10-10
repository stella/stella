import { afterEach, describe, expect, test } from "bun:test";

import {
  EVENT_LOOP_STALL_THRESHOLD_MS,
  startEventLoopDelayMonitor,
  type EventLoopDelayReport,
} from "@/api/lib/observability/event-loop-delay";
import {
  emitEventLoopDelayMetric,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

// Holds the loop the way a synchronous job does: nothing else runs until it
// returns, timers included.
const blockEventLoop = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy wait on purpose.
  }
};

const startRecording = (options: {
  probeIntervalMs: number;
  reportIntervalMs: number;
  stallThresholdMs?: number;
}) => {
  const reports: EventLoopDelayReport[] = [];
  const stalls: number[] = [];
  const monitor = startEventLoopDelayMonitor({
    ...options,
    onReport: (report) => {
      reports.push(report);
    },
    onStall: (stallMs) => {
      stalls.push(stallMs);
    },
  });
  return { monitor, reports, stalls };
};

afterEach(() => {
  resetMetricLineSinkForTesting();
});

describe("event-loop delay monitoring", () => {
  test("a synchronous block is reported as one stall and as the window's max", async () => {
    const BLOCK_MS = 400;
    const STALL_THRESHOLD_MS = 150;
    const { monitor, reports, stalls } = startRecording({
      probeIntervalMs: 20,
      reportIntervalMs: 200,
      stallThresholdMs: STALL_THRESHOLD_MS,
    });
    try {
      // Let both timers arm before the loop is taken away from them.
      await Bun.sleep(60);
      expect(stalls).toEqual([]);

      blockEventLoop(BLOCK_MS);
      await Bun.sleep(450);
    } finally {
      monitor.stop();
    }

    // One stall for one block: the probe reports the lateness once, then
    // re-arms from the time it actually ran.
    expect(stalls).toHaveLength(1);
    const [stallMs = 0] = stalls;
    expect(stallMs).toBeGreaterThan(STALL_THRESHOLD_MS);
    expect(stallMs).toBeLessThanOrEqual(BLOCK_MS + 200);
    expect(Math.max(...reports.map((report) => report.maxMs))).toBeGreaterThan(
      STALL_THRESHOLD_MS,
    );
  });

  test("a loop that is never held reports its delay and no stall", async () => {
    const { monitor, reports, stalls } = startRecording({
      probeIntervalMs: 20,
      reportIntervalMs: 100,
    });
    try {
      await Bun.sleep(350);
    } finally {
      monitor.stop();
    }

    expect(stalls).toEqual([]);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.maxMs).toBeLessThan(EVENT_LOOP_STALL_THRESHOLD_MS);
      expect(report.p99Ms).toBeLessThanOrEqual(report.maxMs);
    }
  });

  test("a stopped monitor reports nothing more", async () => {
    const { monitor, reports, stalls } = startRecording({
      probeIntervalMs: 20,
      reportIntervalMs: 40,
      stallThresholdMs: 50,
    });
    monitor.stop();

    blockEventLoop(150);
    await Bun.sleep(120);

    expect(reports).toEqual([]);
    expect(stalls).toEqual([]);
  });

  test("each window is one undimensioned EMF record with max and p99", () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });

    emitEventLoopDelayMetric({ maxMs: 19_000, p99Ms: 12 });

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
        EventLoopDelayMax: 19_000,
        EventLoopDelayP99: 12,
      },
    ]);
  });
});
