import { describe, expect, test } from "bun:test";

import {
  SELECTION_TOOLBAR_EDGE_MARGIN_PX,
  SELECTION_TOOLBAR_OFFSET_PX,
  selectionToolbarPosition,
} from "@/components/selection-toolbar.logic";

const bounds = { left: 100, top: 80, right: 500, bottom: 400 };

describe("selection action placement", () => {
  test("stays near the selection end below the line when there is room", () => {
    expect(
      selectionToolbarPosition({
        anchor: { left: 300, right: 300, top: 200, bottom: 220 },
        barWidth: 120,
        barHeight: 36,
        bounds,
      }),
    ).toEqual({ left: 300, top: 220 + SELECTION_TOOLBAR_OFFSET_PX });
  });

  test("opens above the end when the scroll container has no room below", () => {
    expect(
      selectionToolbarPosition({
        anchor: { left: 300, right: 300, top: 370, bottom: 390 },
        barWidth: 120,
        barHeight: 36,
        bounds,
      }).top,
    ).toBe(370 - SELECTION_TOOLBAR_OFFSET_PX - 36);
  });

  test("all anchor positions keep the measured bar within its container and below the header", () => {
    const margin = SELECTION_TOOLBAR_EDGE_MARGIN_PX;
    for (const x of [-1000, 0, 100, 250, 500, 2000]) {
      for (const y of [-1000, 0, 80, 200, 400, 2000]) {
        for (const size of [
          { width: 120, height: 36 },
          { width: 380, height: 100 },
        ]) {
          const position = selectionToolbarPosition({
            anchor: { left: x, right: x, top: y, bottom: y },
            barWidth: size.width,
            barHeight: size.height,
            bounds,
          });
          expect(position.left - size.width / 2).toBeGreaterThanOrEqual(
            bounds.left + margin,
          );
          expect(position.left + size.width / 2).toBeLessThanOrEqual(
            bounds.right - margin,
          );
          expect(position.top).toBeGreaterThanOrEqual(bounds.top + margin);
          expect(position.top + size.height).toBeLessThanOrEqual(
            bounds.bottom - margin,
          );
        }
      }
    }
  });
});
