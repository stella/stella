import { panic } from "better-result";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { MATCHER_WORKLOAD_REPORT_COUNT } from "./test-fixtures/matcher-memory-child";

// Five database-free child lifetimes peaked at 500.9 MiB; 640 MiB leaves 139.1 MiB headroom.
const MATCHER_MEMORY_BUDGET_BYTES = 640 * 1024 * 1024;
const WORKLOAD_TIMEOUT_MS = 300_000;

test(
  "a compiled edition screens the monitoring corpus within its memory budget",
  async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--smol",
        fileURLToPath(
          new URL("test-fixtures/matcher-memory-child.ts", import.meta.url),
        ),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let pending = "";
    let reportedPeakBytes = 0;
    let reports = 0;
    const recordReport = (line: string) => {
      const peakKiB = Number(line);
      if (!Number.isSafeInteger(peakKiB) || peakKiB <= 0) {
        panic("Matcher child emitted an invalid RSS report");
      }
      reports += 1;
      reportedPeakBytes = Math.max(reportedPeakBytes, peakKiB * 1024);
      if (reportedPeakBytes > MATCHER_MEMORY_BUDGET_BYTES) {
        child.kill();
      }
    };
    try {
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          recordReport(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }
      pending += decoder.decode();
      if (pending.length !== 0) {
        recordReport(pending);
      }
      const exitCode = await child.exited;
      const errors = await stderr;
      const usage =
        child.resourceUsage() ?? panic("Matcher child resource usage missing");
      // Subprocess maxRSS is bytes; the child's Node-compatible report is KiB.
      const peakBytes = Math.max(reportedPeakBytes, usage.maxRSS);
      console.log(
        JSON.stringify({
          benchmark: "sanctions-matcher-memory",
          peakBytes,
          reportedPeakBytes,
          processPeakBytes: usage.maxRSS,
          budgetBytes: MATCHER_MEMORY_BUDGET_BYTES,
        }),
      );
      expect(peakBytes, errors).toBeLessThanOrEqual(
        MATCHER_MEMORY_BUDGET_BYTES,
      );
      expect(reportedPeakBytes).toBeGreaterThan(0);
      expect(reports).toBe(MATCHER_WORKLOAD_REPORT_COUNT);
      expect(exitCode, errors).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  },
  WORKLOAD_TIMEOUT_MS,
);
