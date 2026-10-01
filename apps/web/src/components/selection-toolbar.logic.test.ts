import { describe, expect, test } from "bun:test";

import {
  SELECTION_TOOLBAR_EDGE_MARGIN_PX,
  SELECTION_TOOLBAR_OFFSET_PX,
  selectionToolbarPosition,
} from "@/components/selection-toolbar.logic";

describe("selectionToolbarPosition", () => {
  test("centres the bar above the selection", () => {
    expect(
      selectionToolbarPosition({
        anchor: { left: 300, top: 200, width: 100 },
        barWidth: 120,
        viewportWidth: 1000,
      }),
    ).toEqual({ left: 350, top: 200 - SELECTION_TOOLBAR_OFFSET_PX });
  });

  test("holds the bar inside the window near either edge", () => {
    expect(
      selectionToolbarPosition({
        anchor: { left: 0, top: 200, width: 20 },
        barWidth: 200,
        viewportWidth: 1000,
      }).left,
    ).toBe(SELECTION_TOOLBAR_EDGE_MARGIN_PX + 100);
    expect(
      selectionToolbarPosition({
        anchor: { left: 980, top: 200, width: 20 },
        barWidth: 200,
        viewportWidth: 1000,
      }).left,
    ).toBe(1000 - SELECTION_TOOLBAR_EDGE_MARGIN_PX - 100);
  });

  test("never rises above the top of the window", () => {
    expect(
      selectionToolbarPosition({
        anchor: { left: 300, top: 10, width: 100 },
        barWidth: 120,
        viewportWidth: 1000,
      }).top,
    ).toBe(SELECTION_TOOLBAR_EDGE_MARGIN_PX);
  });

  test("keeps the selection's centre until the bar has been measured", () => {
    expect(
      selectionToolbarPosition({
        anchor: { left: 300, top: 200, width: 100 },
        barWidth: 0,
        viewportWidth: Number.POSITIVE_INFINITY,
      }).left,
    ).toBe(350);
  });
});
