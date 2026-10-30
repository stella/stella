import { STELLA_TIMING } from "./env.js";

/** Durations only: command arguments and credentials never enter the trace. */
export const timingEnd = (phase: string, startedAt: number): void => {
  if (STELLA_TIMING === "1") {
    process.stderr.write(
      `stella timing ${phase} ${(performance.now() - startedAt).toFixed(3)}ms\n`,
    );
  }
};
