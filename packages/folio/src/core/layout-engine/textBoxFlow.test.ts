/**
 * Floating text-box predicate tests. Mirrors eigenpal #474.
 */

import { describe, expect, test } from "bun:test";

import {
  bandFragmentX,
  floatingTextBoxReservesBand,
  floatingTextBoxWrapsText,
  isFloatingTextBoxBlock,
} from "./textBoxFlow";

describe("isFloatingTextBoxBlock", () => {
  test("recognizes displayMode='float' as floating", () => {
    expect(isFloatingTextBoxBlock({ displayMode: "float" })).toBe(true);
  });

  test("recognizes OOXML floating wrap types as floating", () => {
    expect(isFloatingTextBoxBlock({ wrapType: "square" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "tight" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "through" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "behind" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "inFront" })).toBe(true);
    expect(isFloatingTextBoxBlock({ wrapType: "topAndBottom" })).toBe(true);
  });

  test("inline text boxes are not floating", () => {
    expect(isFloatingTextBoxBlock({ displayMode: "inline" })).toBe(false);
    expect(isFloatingTextBoxBlock({ wrapType: "inline" })).toBe(false);
    expect(isFloatingTextBoxBlock({})).toBe(false);
  });
});

describe("floatingTextBoxWrapsText", () => {
  test("wraps text for square/tight/through", () => {
    expect(
      floatingTextBoxWrapsText({ displayMode: "float", wrapType: "square" }),
    ).toBe(true);
    expect(
      floatingTextBoxWrapsText({ displayMode: "float", wrapType: "tight" }),
    ).toBe(true);
    expect(
      floatingTextBoxWrapsText({ displayMode: "float", wrapType: "through" }),
    ).toBe(true);
  });

  test("does not wrap text for wrapNone (behind/inFront)", () => {
    expect(floatingTextBoxWrapsText({ wrapType: "behind" })).toBe(false);
    expect(floatingTextBoxWrapsText({ wrapType: "inFront" })).toBe(false);
  });

  test("does not wrap text for topAndBottom", () => {
    expect(floatingTextBoxWrapsText({ wrapType: "topAndBottom" })).toBe(false);
  });

  test("does not wrap text for non-floating blocks", () => {
    expect(floatingTextBoxWrapsText({ displayMode: "inline" })).toBe(false);
    expect(floatingTextBoxWrapsText({})).toBe(false);
  });
});

describe("floatingTextBoxReservesBand", () => {
  test("topAndBottom reserves a full-width band, no side wrap (eigenpal #694)", () => {
    const box = { wrapType: "topAndBottom" } as const;
    expect(floatingTextBoxReservesBand(box)).toBe(true);
    expect(floatingTextBoxWrapsText(box)).toBe(false);
    expect(isFloatingTextBoxBlock(box)).toBe(true);
  });

  test("side-wrap and wrapNone types do not reserve a band", () => {
    expect(floatingTextBoxReservesBand({ wrapType: "square" })).toBe(false);
    expect(floatingTextBoxReservesBand({ wrapType: "behind" })).toBe(false);
    expect(floatingTextBoxReservesBand({ displayMode: "float" })).toBe(false);
    expect(floatingTextBoxReservesBand({})).toBe(false);
  });
});

describe("bandFragmentX (eigenpal #694)", () => {
  // 816px page, 96px side margins → 624px content box; 600px banner.
  const geometry = {
    pageWidth: 816,
    marginLeft: 96,
    marginRight: 96,
    boxWidth: 600,
  };
  const EMU_PER_INCH = 914_400; // 1in = 96px at 96 DPI = marginLeft.

  test("no horizontal anchor → content left edge", () => {
    expect(bandFragmentX(undefined, geometry)).toBe(96);
  });

  test("margin-relative align=center centers within the content box", () => {
    // 96 + (624 - 600) / 2
    expect(
      bandFragmentX({ relativeTo: "margin", align: "center" }, geometry),
    ).toBe(108);
  });

  test("margin-relative align=right pins to the content right edge", () => {
    // (816 - 96) - 600
    expect(
      bandFragmentX({ relativeTo: "margin", align: "right" }, geometry),
    ).toBe(120);
  });

  test("page-relative align=center centers within the full page", () => {
    // (816 - 600) / 2
    expect(
      bandFragmentX({ relativeTo: "page", align: "center" }, geometry),
    ).toBe(108);
  });

  test("page-relative align=right pins to the page right edge", () => {
    // 816 - 600
    expect(
      bandFragmentX({ relativeTo: "page", align: "right" }, geometry),
    ).toBe(216);
  });

  test("align=outside aliases right, align=inside aliases left", () => {
    expect(
      bandFragmentX({ relativeTo: "margin", align: "outside" }, geometry),
    ).toBe(120);
    expect(
      bandFragmentX({ relativeTo: "margin", align: "inside" }, geometry),
    ).toBe(96);
  });

  test("explicit posOffset wins over align and is frame-relative", () => {
    // page frame: 0 + 96
    expect(
      bandFragmentX(
        { relativeTo: "page", posOffset: EMU_PER_INCH, align: "center" },
        geometry,
      ),
    ).toBe(96);
    // margin frame: 96 + 96
    expect(
      bandFragmentX(
        { relativeTo: "margin", posOffset: EMU_PER_INCH },
        geometry,
      ),
    ).toBe(192);
  });
});
