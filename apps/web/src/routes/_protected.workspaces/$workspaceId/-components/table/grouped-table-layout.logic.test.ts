import { describe, expect, test } from "bun:test";

import {
  getGroupSkeletonLayout,
  GROUP_SKELETON_ROW_KEYS,
  GROUP_TABLE_PAGE_SIZE,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout.logic";

describe("grouped table loading layout", () => {
  test("reserves the first page's exact capacity without unbounded skeleton DOM", () => {
    for (let totalRowCount = 0; totalRowCount <= 1000; totalRowCount += 1) {
      const { fillerRowCount, skeletonRowCount } =
        getGroupSkeletonLayout(totalRowCount);

      expect(skeletonRowCount).toBeLessThanOrEqual(
        GROUP_SKELETON_ROW_KEYS.length,
      );
      expect(fillerRowCount).toBeGreaterThanOrEqual(0);
      expect(skeletonRowCount + fillerRowCount).toBe(
        Math.min(totalRowCount, GROUP_TABLE_PAGE_SIZE),
      );
    }
  });

  test("uses a compact placeholder before the group count is known", () => {
    expect(getGroupSkeletonLayout(undefined)).toEqual({
      skeletonRowCount: 3,
      fillerRowCount: 0,
    });
  });
});
