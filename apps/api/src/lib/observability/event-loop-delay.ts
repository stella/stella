/**
 * Event-loop delay, measured in the API process.
 *
 * Every request on a task shares one event loop, so synchronous work anywhere
 * in the process (a background job, a large parse, a hash over a big buffer)
 * delays every request the task is serving, whatever route it is on. The
 * per-request latency metric shows that only as a spread of slow routes; this
 * names the cause.
 *
 * Two signals, each from its own timer:
 *
 * - a report every `reportIntervalMs`: the highest and the 99th-percentile
 *   delay `monitorEventLoopDelay` saw in that window, then the histogram is
 *   reset, so each report covers its own window only;
 * - a stall, as soon as the loop is free again: a probe that fires every
 *   `probeIntervalMs` and measures how late it ran. A lateness above
 *   `stallThresholdMs` is reported once, with its length, without waiting for
 *   the window to close.
 *
 * Side-effect free: nothing runs until `startEventLoopDelayMonitor` is called,
 * and the caller supplies where reports and stalls go. Both timers are unref'd,
 * so the monitor never keeps a process alive.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

/** A single delay longer than this is a stall: every request waited for it. */
export const EVENT_LOOP_STALL_THRESHOLD_MS = 1000;

const DEFAULT_REPORT_INTERVAL_MS = 60_000;
const DEFAULT_PROBE_INTERVAL_MS = 500;
// The histogram samples the loop on its own timer at this resolution; finer
// costs wakeups and buys nothing at a one-second stall threshold.
const HISTOGRAM_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export type EventLoopDelayReport = {
  /** The longest delay in the window, in milliseconds. */
  maxMs: number;
  /** The 99th-percentile delay in the window, in milliseconds. */
  p99Ms: number;
};

type StartEventLoopDelayMonitorOptions = {
  onReport: (report: EventLoopDelayReport) => void;
  onStall: (stallMs: number) => void;
  reportIntervalMs?: number;
  probeIntervalMs?: number;
  stallThresholdMs?: number;
};

const toMilliseconds = (nanoseconds: number): number =>
  Math.round(nanoseconds / NANOSECONDS_PER_MILLISECOND);

export const startEventLoopDelayMonitor = ({
  onReport,
  onStall,
  probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
  reportIntervalMs = DEFAULT_REPORT_INTERVAL_MS,
  stallThresholdMs = EVENT_LOOP_STALL_THRESHOLD_MS,
}: StartEventLoopDelayMonitorOptions): { stop: () => void } => {
  const histogram = monitorEventLoopDelay({
    resolution: HISTOGRAM_RESOLUTION_MS,
  });
  histogram.enable();

  const reportTimer = setInterval(() => {
    // A window with no samples has nothing to say; its zeros would read as
    // a perfectly idle loop.
    if (histogram.count > 0) {
      onReport({
        maxMs: toMilliseconds(histogram.max),
        p99Ms: toMilliseconds(histogram.percentile(99)),
      });
    }
    histogram.reset();
  }, reportIntervalMs);
  reportTimer.unref();

  let expectedAt = performance.now() + probeIntervalMs;
  const probeTimer = setInterval(() => {
    const now = performance.now();
    const lateMs = now - expectedAt;
    expectedAt = now + probeIntervalMs;
    if (lateMs > stallThresholdMs) {
      onStall(Math.round(lateMs));
    }
  }, probeIntervalMs);
  probeTimer.unref();

  return {
    stop: () => {
      clearInterval(reportTimer);
      clearInterval(probeTimer);
      histogram.disable();
    },
  };
};
