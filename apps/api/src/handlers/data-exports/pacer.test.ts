import { describe, expect, test } from "bun:test";

import {
  createExportPacer,
  DATA_EXPORT_PACER_OPTIONS,
  paceDelayMs,
} from "@/api/handlers/data-exports/pacer";

describe("export pacing", () => {
  test("backs off hard while interactive work is waiting", () => {
    const { baseDelayMs, busyDelayMs, busyLagMs } = DATA_EXPORT_PACER_OPTIONS;
    expect(paceDelayMs(0, DATA_EXPORT_PACER_OPTIONS)).toBe(baseDelayMs);
    expect(paceDelayMs(busyLagMs - 1, DATA_EXPORT_PACER_OPTIONS)).toBe(
      baseDelayMs,
    );
    expect(paceDelayMs(busyLagMs, DATA_EXPORT_PACER_OPTIONS)).toBe(busyDelayMs);
    expect(busyDelayMs).toBeGreaterThan(baseDelayMs);
  });

  test("always pauses, even when the process is idle", async () => {
    const pacer = createExportPacer({
      baseDelayMs: 20,
      busyDelayMs: 20,
      busyLagMs: 1_000_000,
    });
    const started = performance.now();
    await pacer.pace();
    pacer.close();
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });
});
