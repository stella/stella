// How an export yields to interactive work. The worker runs inside the API
// process, so the event loop's own delay is the most direct signal that
// requests are waiting: while it is high the export backs off hard, and
// otherwise it still pauses briefly between files and database pages so it
// never runs flat out.

import { monitorEventLoopDelay } from "node:perf_hooks";

export type PacerOptions = {
  /** Pause after every unit of work, even when the process is idle. */
  baseDelayMs: number;
  /** Pause while interactive work is waiting. */
  busyDelayMs: number;
  /** p99 event-loop delay at or above which the process counts as busy. */
  busyLagMs: number;
};

export const DATA_EXPORT_PACER_OPTIONS = {
  baseDelayMs: 5,
  busyDelayMs: 250,
  busyLagMs: 40,
} as const satisfies PacerOptions;

/** The pause after one unit of work, given the recent event-loop delay. */
export const paceDelayMs = (lagMs: number, options: PacerOptions): number =>
  lagMs >= options.busyLagMs ? options.busyDelayMs : options.baseDelayMs;

export type ExportPacer = {
  pace: () => Promise<void>;
  close: () => void;
};

const NANOS_PER_MILLI = 1_000_000;
const HISTOGRAM_RESOLUTION_MS = 10;

export const createExportPacer = (
  options: PacerOptions = DATA_EXPORT_PACER_OPTIONS,
): ExportPacer => {
  const histogram = monitorEventLoopDelay({
    resolution: HISTOGRAM_RESOLUTION_MS,
  });
  histogram.enable();
  return {
    pace: async () => {
      const lagMs = histogram.percentile(99) / NANOS_PER_MILLI;
      // Each pause judges only the delay since the previous one.
      histogram.reset();
      await Bun.sleep(paceDelayMs(lagMs, options));
    },
    close: () => {
      histogram.disable();
    },
  };
};
