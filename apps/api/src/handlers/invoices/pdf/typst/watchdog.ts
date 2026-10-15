import { panic } from "better-result";
import { workerData } from "node:worker_threads";

import { TYPST_MEMORY_SIGNAL } from "./protocol";

const SAMPLE_MS = 10;

const isWatchdogData = (
  value: unknown,
): value is { capBytes: number; peak: Float64Array } =>
  typeof value === "object" &&
  value !== null &&
  "capBytes" in value &&
  typeof value.capBytes === "number" &&
  "peak" in value &&
  value.peak instanceof Float64Array;

const data: unknown = workerData;
const { capBytes, peak } = isWatchdogData(data)
  ? data
  : panic("The Typst watchdog needs a memory cap and a peak buffer");

// Runs on its own thread, so it keeps sampling while the render thread is
// busy inside a synchronous WASM compile. Exceeding the cap ends the whole
// renderer process; the session reads the signal as a memory rejection.
setInterval(() => {
  const rss = process.memoryUsage.rss();
  peak[0] = Math.max(peak[0] ?? 0, rss);
  if (rss > capBytes) {
    process.kill(process.pid, TYPST_MEMORY_SIGNAL);
  }
}, SAMPLE_MS);
