import { describe, expect, test } from "bun:test";

import { hasActiveExtractionProgress } from "./extraction-run-progress.logic";

describe("extraction run progress", () => {
  test.each(["planning", "running", "finalizing"])(
    "shows counters for an active %s run",
    (status) => {
      expect(hasActiveExtractionProgress({ status, total: 2 })).toBe(true);
    },
  );

  test.each(["completed", "failed", "skipped"])(
    "does not reuse counters from a historical %s run",
    (status) => {
      expect(hasActiveExtractionProgress({ status, total: 2 })).toBe(false);
    },
  );

  test("uses the loading state when the durable row or total is unavailable", () => {
    expect(hasActiveExtractionProgress(null)).toBe(false);
    expect(hasActiveExtractionProgress({ status: "running", total: 0 })).toBe(
      false,
    );
  });
});
