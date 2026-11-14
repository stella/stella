import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { readerCopyMenuBox } from "@/components/legal-reader/annotations/reader-copy-menu.logic";

test.each([
  {
    bar: { bottom: 80, left: 20, top: 40, width: 300 },
    expected: { left: 20, opensUp: false, top: 84, width: 300 },
    name: "matches a toolbar wider than the minimum",
  },
  {
    bar: { bottom: 80, left: 20, top: 40, width: 160 },
    expected: { left: 20, opensUp: false, top: 84, width: 240 },
    name: "widens a narrow toolbar's menu to the minimum",
  },
  {
    bar: { bottom: 80, left: 200, top: 40, width: 100 },
    expected: { left: 80, opensUp: false, top: 84, width: 240 },
    name: "shifts a widened menu left to stay in the viewport",
  },
  {
    bar: { bottom: 80, left: -20, top: 40, width: 500 },
    expected: { left: 0, opensUp: false, top: 84, width: 320 },
    name: "clips a toolbar wider than the viewport",
  },
  {
    bar: { bottom: 590, left: 20, top: 550, width: 260 },
    expected: { bottom: 54, left: 20, opensUp: true, width: 260 },
    name: "opens above near the bottom edge",
  },
])("$name", ({ bar, expected }) => {
  expect(
    readerCopyMenuBox({
      bar,
      menuHeight: 200,
      menuWidth: 240,
      viewport: { height: 600, width: 320 },
    }),
  ).toEqual(expected);
});

test("reader copy menu stays in the viewport at its minimum width", () => {
  const TEST_MAX_PX = 2000;
  assertProperty(
    "reader copy menu stays in the viewport at its minimum width",
    fc.property(
      fc.integer({ min: -TEST_MAX_PX, max: TEST_MAX_PX }),
      fc.integer({ min: 0, max: TEST_MAX_PX }),
      fc.integer({ min: 0, max: TEST_MAX_PX }),
      fc.integer({ min: 1, max: TEST_MAX_PX }),
      (barLeft, barWidth, menuWidth, viewportWidth) => {
        const box = readerCopyMenuBox({
          bar: { bottom: 80, left: barLeft, top: 40, width: barWidth },
          menuHeight: 200,
          menuWidth,
          viewport: { height: 600, width: viewportWidth },
        });
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(viewportWidth);
        expect(box.width).toBeGreaterThanOrEqual(
          Math.min(menuWidth, viewportWidth),
        );
        // A menu that fits keeps the toolbar's left edge.
        if (barLeft >= 0 && barLeft + box.width <= viewportWidth) {
          expect(box.left).toBe(barLeft);
        }
      },
    ),
  );
});
