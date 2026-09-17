import { describe, expect, test } from "bun:test";

import {
  tableRowWindow,
  UNMEASURED_WINDOW_ROW_COUNT,
} from "@/components/workspaces/table/workspace-table/row-window.logic";

const ROW_PX = 48;

/** A measured window of `count` rows starting at `startIndex`. */
const measuredWindow = ({
  count,
  scrollMargin = 0,
  startIndex,
}: {
  count: number;
  scrollMargin?: number;
  startIndex: number;
}) =>
  Array.from({ length: count }, (_unused, offset) => {
    const index = startIndex + offset;
    return {
      index,
      start: scrollMargin + index * ROW_PX,
      end: scrollMargin + (index + 1) * ROW_PX,
    };
  });

describe("the rows a table body paints", () => {
  test("never paints nothing while it has rows", () => {
    // The virtualizer answers with an empty window whenever its scroll element
    // measures zero height, at any row count.
    for (let rowCount = 1; rowCount <= 500; rowCount++) {
      const { indexes, paddingTop, paddingBottom } = tableRowWindow({
        virtualRows: [],
        rowCount,
        totalSize: rowCount * ROW_PX,
        scrollMargin: 0,
        estimatedRowPx: ROW_PX,
      });

      expect(indexes.length).toBeGreaterThanOrEqual(1);
      expect(indexes.length).toBeLessThanOrEqual(
        Math.min(rowCount, UNMEASURED_WINDOW_ROW_COUNT),
      );
      expect(indexes.at(-1)).toBeLessThan(rowCount);
      expect(paddingTop).toBe(0);
      expect(paddingBottom).toBeGreaterThanOrEqual(0);
      // The filler still stands for every row left unpainted, so the scroll
      // keeps the height it had before the measurement arrives.
      expect(paddingBottom + indexes.length * ROW_PX).toBe(rowCount * ROW_PX);
    }
  });

  test("paints no row for a table that has none", () => {
    const { indexes, paddingTop, paddingBottom } = tableRowWindow({
      virtualRows: [],
      rowCount: 0,
      totalSize: 0,
      scrollMargin: 0,
      estimatedRowPx: ROW_PX,
    });

    expect(indexes).toEqual([]);
    expect(paddingTop).toBe(0);
    expect(paddingBottom).toBe(0);
  });

  test("hands the window back to the virtualizer once it has one", () => {
    const virtualRows = measuredWindow({ count: 10, startIndex: 20 });

    const { indexes, paddingTop, paddingBottom } = tableRowWindow({
      virtualRows,
      rowCount: 100,
      totalSize: 100 * ROW_PX,
      scrollMargin: 0,
      estimatedRowPx: ROW_PX,
    });

    expect(indexes).toEqual(virtualRows.map((virtualRow) => virtualRow.index));
    expect(paddingTop).toBe(20 * ROW_PX);
    expect(paddingBottom).toBe(70 * ROW_PX);
  });

  test("keeps a shared scroll's offset out of the fillers it draws", () => {
    // A grouped section's rows container already sits at `scrollMargin` in the
    // DOM flow, while the virtual extents are measured from the scroll's start.
    const scrollMargin = 640;
    const virtualRows = measuredWindow({
      count: 4,
      scrollMargin,
      startIndex: 2,
    });

    const { paddingTop, paddingBottom } = tableRowWindow({
      virtualRows,
      rowCount: 12,
      // `getTotalSize()` is the rows' own height: it takes the margin back off.
      totalSize: 12 * ROW_PX,
      scrollMargin,
      estimatedRowPx: ROW_PX,
    });

    expect(paddingTop).toBe(2 * ROW_PX);
    expect(paddingBottom).toBe(6 * ROW_PX);
  });
});
