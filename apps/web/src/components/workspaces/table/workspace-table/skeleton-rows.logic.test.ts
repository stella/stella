import { describe, expect, test } from "bun:test";

import {
  SKELETON_ROW_KEYS,
  tableSkeletonRowCount,
} from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";

describe("table skeleton rows", () => {
  test("stands in for the page without unbounded placeholder DOM", () => {
    for (
      let expectedRowCount = 0;
      expectedRowCount <= 1000;
      expectedRowCount++
    ) {
      const rowCount = tableSkeletonRowCount(expectedRowCount);

      expect(rowCount).toBeLessThanOrEqual(SKELETON_ROW_KEYS.length);
      expect(rowCount).toBeGreaterThanOrEqual(1);
      // A page the cap can hold is stood in row for row.
      if (
        expectedRowCount >= 1 &&
        expectedRowCount <= SKELETON_ROW_KEYS.length
      ) {
        expect(rowCount).toBe(expectedRowCount);
      }
    }
  });

  test("draws a compact stand-in when the page size is unknown", () => {
    const rowCount = tableSkeletonRowCount();

    expect(rowCount).toBeGreaterThanOrEqual(1);
    expect(rowCount).toBeLessThanOrEqual(SKELETON_ROW_KEYS.length);
  });

  test("reserves a distinct key per row it can draw", () => {
    expect(new Set(SKELETON_ROW_KEYS).size).toBe(SKELETON_ROW_KEYS.length);
  });
});
