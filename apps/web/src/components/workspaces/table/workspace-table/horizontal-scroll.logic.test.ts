import { describe, expect, test } from "bun:test";

import {
  anchoredHorizontalScroll,
  horizontalMaxScroll,
} from "@/components/workspaces/table/workspace-table/horizontal-scroll.logic";
import type { HorizontalScrollMetrics } from "@/components/workspaces/table/workspace-table/horizontal-scroll.logic";

/** A results grid wider than the reading column it is drawn in. */
const TABLE_WIDTH = 1600;
/** The content column with nothing docked beside it. */
const OPEN_WRAPPER_WIDTH = 1200;
/** The same column once an inspector dock takes its share of the frame. */
const DOCKED_WRAPPER_WIDTH = 760;

describe("table horizontal scroll anchoring", () => {
  test("a dock opening beside the table leaves the offset alone", () => {
    // The reported defect: a reader who has scrolled nowhere is also sitting
    // on the end edge while the grid fits, so pinning the end edge shifted
    // the leading columns out of view the moment the dock took width.
    for (const tableWidth of [600, 900, 1200, TABLE_WIDTH]) {
      const previous: HorizontalScrollMetrics = {
        tableWidth,
        wrapperWidth: OPEN_WRAPPER_WIDTH,
      };
      const next: HorizontalScrollMetrics = {
        tableWidth,
        wrapperWidth: DOCKED_WRAPPER_WIDTH,
      };

      expect(
        anchoredHorizontalScroll({ next, previous, scrollLeft: 0 }),
      ).toBeNull();
    }
  });

  test("a reader mid-scroll keeps their columns when the viewport narrows", () => {
    const previous: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };
    const next: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: DOCKED_WRAPPER_WIDTH,
    };

    expect(
      anchoredHorizontalScroll({ next, previous, scrollLeft: 240 }),
    ).toBeNull();
  });

  test("narrowing the viewport never scrolls the grid further along", () => {
    // The invariant behind the fix, over every viewport the frame can hand
    // this table: a change of available width may only clamp an offset that
    // no longer fits, never advance one.
    for (
      let wrapperWidth = 320;
      wrapperWidth < OPEN_WRAPPER_WIDTH;
      wrapperWidth += 20
    ) {
      const previous: HorizontalScrollMetrics = {
        tableWidth: TABLE_WIDTH,
        wrapperWidth: OPEN_WRAPPER_WIDTH,
      };
      const next: HorizontalScrollMetrics = {
        tableWidth: TABLE_WIDTH,
        wrapperWidth,
      };

      for (const scrollLeft of [0, 1, 120, 399, 400]) {
        const anchored = anchoredHorizontalScroll({
          next,
          previous,
          scrollLeft,
        });

        expect(anchored === null || anchored <= scrollLeft).toBe(true);
      }
    }
  });

  test("widening the viewport back does not move the offset either", () => {
    const previous: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: DOCKED_WRAPPER_WIDTH,
    };
    const next: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };

    expect(
      anchoredHorizontalScroll({ next, previous, scrollLeft: 300 }),
    ).toBeNull();
  });

  test("a grid that grows keeps a reader parked on the end edge there", () => {
    const previous: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };
    const next: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH + 300,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };

    expect(
      anchoredHorizontalScroll({
        next,
        previous,
        scrollLeft: horizontalMaxScroll(previous),
      }),
    ).toBe(horizontalMaxScroll(next));
  });

  test("a grid that grows leaves a reader mid-scroll where they were", () => {
    const previous: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };
    const next: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH + 300,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };

    expect(
      anchoredHorizontalScroll({ next, previous, scrollLeft: 120 }),
    ).toBeNull();
  });

  test("an offset past the end of a shrunken grid is clamped to it", () => {
    const previous: HorizontalScrollMetrics = {
      tableWidth: TABLE_WIDTH,
      wrapperWidth: OPEN_WRAPPER_WIDTH,
    };

    // A column hidden at a fixed viewport, with the reader well before the end.
    expect(
      anchoredHorizontalScroll({
        next: { tableWidth: 1300, wrapperWidth: OPEN_WRAPPER_WIDTH },
        previous,
        scrollLeft: 320,
      }),
    ).toBe(100);

    // The same hiding while the dock opens: the viewport moved too, and the
    // offset still has to land inside the new range.
    expect(
      anchoredHorizontalScroll({
        next: { tableWidth: 800, wrapperWidth: DOCKED_WRAPPER_WIDTH },
        previous,
        scrollLeft: 320,
      }),
    ).toBe(40);
  });

  test("a grid that fits its viewport is scrolled back to the start", () => {
    expect(
      anchoredHorizontalScroll({
        next: { tableWidth: 900, wrapperWidth: OPEN_WRAPPER_WIDTH },
        previous: { tableWidth: TABLE_WIDTH, wrapperWidth: OPEN_WRAPPER_WIDTH },
        scrollLeft: 320,
      }),
    ).toBe(0);
  });

  test("the first measurement has nothing to anchor against", () => {
    expect(
      anchoredHorizontalScroll({
        next: { tableWidth: TABLE_WIDTH, wrapperWidth: DOCKED_WRAPPER_WIDTH },
        previous: null,
        scrollLeft: 0,
      }),
    ).toBeNull();
  });

  test("an RTL container's negative offset is left untouched", () => {
    // RTL reports the offset as negative, which no write branch matches; the
    // dock must not move those columns either.
    for (const scrollLeft of [-400, -120, 0]) {
      expect(
        anchoredHorizontalScroll({
          next: { tableWidth: TABLE_WIDTH, wrapperWidth: DOCKED_WRAPPER_WIDTH },
          previous: {
            tableWidth: TABLE_WIDTH,
            wrapperWidth: OPEN_WRAPPER_WIDTH,
          },
          scrollLeft,
        }),
      ).toBeNull();
    }
  });
});
