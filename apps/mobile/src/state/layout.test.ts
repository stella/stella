import { describe, expect, test } from "bun:test";

import type { LayoutMetrics } from "./layout";
import { deriveLayout } from "./layout";

describe("the app's columns", () => {
  test("a phone, upright or turned, keeps one column", () => {
    expect(deriveLayout({ width: 402, height: 874 }).usesSplitView).toBe(false);
    expect(deriveLayout({ width: 874, height: 402 }).usesSplitView).toBe(false);
  });

  test("an iPad in Slide Over keeps one column", () => {
    expect(deriveLayout({ width: 375, height: 1180 }).usesSplitView).toBe(
      false,
    );
  });

  test("an iPad upright or across shows its list beside the selection", () => {
    expect(deriveLayout({ width: 820, height: 1180 })).toEqual({
      usesSplitView: true,
      listPaneWidth: 300,
      divisionWidth: 0,
    });
    expect(deriveLayout({ width: 1180, height: 820 })).toEqual({
      usesSplitView: true,
      listPaneWidth: 400,
      divisionWidth: 0,
    });
  });

  const FOLDABLE: LayoutMetrics = {
    hasHinge: true,
    horizontalSizeClass: "regular",
    safeAreaLeft: 0,
    safeAreaRight: 0,
  };

  test("an unfolded foldable splits at its fold and draws nothing across it", () => {
    expect(
      deriveLayout({
        width: 760,
        height: 700,
        metrics: {
          ...FOLDABLE,
          division: { x: 372, y: 0, width: 16, height: 700 },
        },
      }),
    ).toEqual({ usesSplitView: true, listPaneWidth: 372, divisionWidth: 16 });
  });

  test("a folded foldable keeps one column, however wide it reports", () => {
    expect(
      deriveLayout({
        width: 760,
        height: 700,
        metrics: { ...FOLDABLE, horizontalSizeClass: "compact" },
      }).usesSplitView,
    ).toBe(false);
  });
});
