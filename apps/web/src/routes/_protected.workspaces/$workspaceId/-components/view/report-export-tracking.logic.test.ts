import { describe, expect, test } from "bun:test";

import {
  nextTrackedAt,
  retainNewestTrackedExports,
} from "./report-export-tracking.logic";
import type { TrackedReportExport } from "./report-export-tracking.logic";

const trackedExport = (
  index: number,
  trackedAt: number = index,
): TrackedReportExport => ({
  exportId: `export-${index}`,
  mode: "workspace",
  trackedAt,
  workspaceId: "workspace-1",
});

describe("report export tracking bounds", () => {
  test("retains the newest 100 active exports", () => {
    const retained = retainNewestTrackedExports(
      Array.from({ length: 101 }, (_, index) => trackedExport(index)),
    );

    expect(Object.keys(retained)).toHaveLength(100);
    expect(retained["export-0"]).toBeUndefined();
    expect(retained["export-100"]).toBeDefined();
  });

  test("a retracked export keeps its newest pointer without consuming two slots", () => {
    const retained = retainNewestTrackedExports([
      ...Array.from({ length: 101 }, (_, index) => trackedExport(index)),
      trackedExport(0, 101),
    ]);

    expect(Object.keys(retained)).toHaveLength(100);
    expect(retained["export-0"]?.trackedAt).toBe(101);
    expect(retained["export-1"]).toBeUndefined();
  });

  test("assigns a strictly newer timestamp when the clock does not advance", () => {
    expect(
      nextTrackedAt(
        {
          a: trackedExport(1, 50),
          b: trackedExport(2, 51),
        },
        50,
      ),
    ).toBe(52);
  });
});
