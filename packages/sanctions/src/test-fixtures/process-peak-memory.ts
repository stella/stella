import { panic } from "better-result";
import { readFileSync } from "node:fs";

const BYTES_PER_KIB = 1024;

/** Peak of this executed process's address space, excluding its launcher. */
export const processPeakMemoryBytes = () => {
  if (process.platform === "linux") {
    const match = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(
      readFileSync("/proc/self/status", "utf-8"),
    );
    const peakKiB = Number(match?.at(1));
    if (!Number.isSafeInteger(peakKiB) || peakKiB <= 0) {
      panic("Linux process peak memory is missing or invalid");
    }
    return peakKiB * BYTES_PER_KIB;
  }
  return process.resourceUsage().maxRSS * BYTES_PER_KIB;
};
