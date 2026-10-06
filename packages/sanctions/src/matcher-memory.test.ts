import { panic } from "better-result";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { MATCHER_WORKLOAD_REPORT_COUNT } from "./test-fixtures/monitoring-corpus";

// Worst correct peak: Darwin 500.9 MiB (Linux 421.0); mutant 593.2. Their midpoint leaves 46 MiB on either side.
const MATCHER_MEMORY_BUDGET_BYTES = 547 * 1024 * 1024;
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
      const peakBytes = Number(line);
      if (!Number.isSafeInteger(peakBytes) || peakBytes <= 0) {
        panic("Matcher child emitted an invalid RSS report");
      }
      reports += 1;
      reportedPeakBytes = Math.max(reportedPeakBytes, peakBytes);
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
      // Linux wait4 usage can retain the launcher's pre-exec high-water mark.
      // The executed child's own address-space reports define the guard.
      const peakBytes = reportedPeakBytes;
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
