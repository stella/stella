import { STELLA_TIMING } from "./env.js";

/** Durations only: command arguments and credentials never enter the trace. */
export const timingDuration = (phase: string, durationMs: number): void => {
  if (STELLA_TIMING === "1") {
    process.stderr.write(`stella timing ${phase} ${durationMs.toFixed(3)}ms\n`);
  }
};

/** Finish one uninterrupted synchronous or asynchronous phase. */
export const timingEnd = (phase: string, startedAt: number): void => {
  timingDuration(phase, performance.now() - startedAt);
};
