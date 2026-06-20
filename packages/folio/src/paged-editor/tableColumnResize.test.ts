import { describe, expect, test } from "bun:test";

import { resizeColumnPair } from "./tableColumnResize";

const MIN = 300;

describe("resizeColumnPair", () => {
  test("LTR: dragging the boundary right grows the left column and shrinks the right", () => {
    expect(resizeColumnPair(2000, 3000, 150, false, MIN)).toEqual({
      left: 2150,
      right: 2850,
    });
  });

  test("RTL (bidiVisual): the delta is inverted so the visual-left (logical right) column grows (eigenpal/docx-editor#940)", () => {
    expect(resizeColumnPair(2000, 3000, 150, true, MIN)).toEqual({
      left: 1850,
      right: 3150,
    });
  });

  test("keeps the original widths when a side would fall below the minimum", () => {
    // LTR drag left that would push the left column under MIN.
    expect(resizeColumnPair(MIN, 3000, -50, false, MIN)).toEqual({
      left: MIN,
      right: 3000,
    });
    // Same guard under RTL inversion (here a positive delta shrinks the left).
    expect(resizeColumnPair(MIN, 3000, 50, true, MIN)).toEqual({
      left: MIN,
      right: 3000,
    });
  });
});
