import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  EVENT_LOOP_STALL_THRESHOLD_MS,
  type EventLoopDelayReport,
  startEventLoopDelayMonitor,
} from "@/api/lib/observability/event-loop-delay";
import {
  emitEventLoopDelayMetric,
  emitProcessMemoryLog,
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
    onReportInterval: () => {},
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

  test("reports memory on a timer tick even before the histogram has samples", () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    const originalSetInterval = globalThis.setInterval;
    let reportTick: (() => void) | undefined;
    const interval = spyOn(globalThis, "setInterval").mockImplementation(
      (
        ...[handler, delay, ...args]: Parameters<typeof globalThis.setInterval>
      ) => {
        if (delay === 200 && typeof handler === "function") {
          reportTick = () => handler(...args);
        }
        return originalSetInterval(handler, delay, ...args);
      },
    );
    const reports: EventLoopDelayReport[] = [];
    const monitor = startEventLoopDelayMonitor({
      reportIntervalMs: 200,
      onReportInterval: () =>
        emitProcessMemoryLog({
          rssBytes: 10,
          heapUsedBytes: 5,
          arrayBuffersBytes: 2,
          workPools: {
            "heavy-sidecar": {
              inFlight: 8,
              queued: 9,
              bytesInFlight: 10,
              refusedBusy: 11,
              refusedMemory: 12,
              deadlineCancelled: 13,
            },
          },
        }),
      onReport: (report) => {
        reports.push(report);
      },
      onStall: () => {},
    });
    try {
      expect(reportTick).toBeDefined();
      reportTick?.();
      expect(reports).toEqual([]);
      expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
        {
          severity: "INFO",
          message: "runtime.process_memory",
          rssBytes: 10,
          heapUsedBytes: 5,
          arrayBuffersBytes: 2,
          "work_pool.heavy-sidecar.inFlight": 8,
          "work_pool.heavy-sidecar.queued": 9,
          "work_pool.heavy-sidecar.bytesInFlight": 10,
          "work_pool.heavy-sidecar.refusedBusy": 11,
          "work_pool.heavy-sidecar.refusedMemory": 12,
          "work_pool.heavy-sidecar.deadlineCancelled": 13,
        },
      ]);
    } finally {
      monitor.stop();
      interval.mockRestore();
    }
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

  test("logs only bounded process counters without creating custom metrics", () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });

    emitProcessMemoryLog({
      rssBytes: 1_500_000_000,
      heapUsedBytes: 400_000_000,
      arrayBuffersBytes: 300_000_000,
      workPools: {},
    });

    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      {
        severity: "INFO",
        message: "runtime.process_memory",
        rssBytes: 1_500_000_000,
        heapUsedBytes: 400_000_000,
        arrayBuffersBytes: 300_000_000,
      },
    ]);
    expect(lines.at(0)?.length).toBeLessThan(300);
  });
});
