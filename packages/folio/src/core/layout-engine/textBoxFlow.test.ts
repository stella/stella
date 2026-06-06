/**
 * Floating text-box predicate tests. Mirrors eigenpal #474.
 */

import { describe, expect, test } from "bun:test";

import {
  bandFragmentX,
  bandTopContentY,
  floatingTextBoxReservesBand,
  floatingTextBoxWrapsText,
  isFloatingTextBoxBlock,
  isPageFrameRelativeAnchor,
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

describe("isPageFrameRelativeAnchor (eigenpal #694)", () => {
  test("page, text margin, and margin strips pin to the page frame", () => {
    expect(isPageFrameRelativeAnchor("page")).toBe(true);
    expect(isPageFrameRelativeAnchor("margin")).toBe(true);
    expect(isPageFrameRelativeAnchor("topMargin")).toBe(true);
    expect(isPageFrameRelativeAnchor("bottomMargin")).toBe(true);
    expect(isPageFrameRelativeAnchor("insideMargin")).toBe(true);
    expect(isPageFrameRelativeAnchor("outsideMargin")).toBe(true);
  });

  test("flow-relative and absent anchors are not page-pinned", () => {
    expect(isPageFrameRelativeAnchor("paragraph")).toBe(false);
    expect(isPageFrameRelativeAnchor("line")).toBe(false);
    expect(isPageFrameRelativeAnchor(undefined)).toBe(false);
  });
});

describe("bandTopContentY (eigenpal #694)", () => {
  // 1056px page, 96px top / 48px bottom margin → content frame [96, 1008];
  // 100px band box. Returned Y is content-relative (0 = content top).
  const geometry = {
    pageHeight: 1056,
    marginTop: 96,
    marginBottom: 48,
    boxHeight: 100,
  };
  const EMU_PER_INCH = 914_400; // 1in = 96px at 96 DPI = marginTop.

  test("page/margin offset-0 anchors keep their content-relative origin", () => {
    // page frame top 0 → content-relative -marginTop; margin frame top → 0.
    expect(bandTopContentY({ relativeTo: "page" }, geometry)).toBe(-96);
    expect(bandTopContentY({ relativeTo: "margin" }, geometry)).toBe(0);
    expect(bandTopContentY(undefined, geometry)).toBe(0);
  });

  test("center align resolves to the middle of the anchor frame", () => {
    // margin frame [96, 1008]: 96 + (912 - 100) / 2 = 502 → content 406.
    expect(
      bandTopContentY({ relativeTo: "margin", align: "center" }, geometry),
    ).toBe(406);
    // page frame [0, 1056]: (1056 - 100) / 2 = 478 → content 382.
    expect(
      bandTopContentY({ relativeTo: "page", align: "center" }, geometry),
    ).toBe(382);
  });

  test("bottom/outside align pins the box to the frame bottom", () => {
    // margin frame bottom 1008 - 100 = 908 → content 812.
    expect(
      bandTopContentY({ relativeTo: "margin", align: "bottom" }, geometry),
    ).toBe(812);
    expect(
      bandTopContentY({ relativeTo: "margin", align: "outside" }, geometry),
    ).toBe(812);
    // inside aliases top: margin frame top 96 → content 0.
    expect(
      bandTopContentY({ relativeTo: "margin", align: "inside" }, geometry),
    ).toBe(0);
  });

  test("margin-strip anchors resolve to their strip", () => {
    // topMargin/insideMargin → [0, 96] strip top → content -96.
    expect(bandTopContentY({ relativeTo: "topMargin" }, geometry)).toBe(-96);
    expect(bandTopContentY({ relativeTo: "insideMargin" }, geometry)).toBe(-96);
    // bottomMargin/outsideMargin → [1008, 1056] strip top → content 912.
    expect(bandTopContentY({ relativeTo: "bottomMargin" }, geometry)).toBe(912);
    expect(bandTopContentY({ relativeTo: "outsideMargin" }, geometry)).toBe(
      912,
    );
    // bottom-aligned within the bottom strip: 1056 - 100 = 956 → content 860.
    expect(
      bandTopContentY(
        { relativeTo: "bottomMargin", align: "bottom" },
        geometry,
      ),
    ).toBe(860);
  });

  test("explicit posOffset wins over align and is frame-relative", () => {
    // margin frame top 96 + 96 = 192 → content 96 (align ignored).
    expect(
      bandTopContentY(
        { relativeTo: "margin", posOffset: EMU_PER_INCH, align: "center" },
        geometry,
      ),
    ).toBe(96);
  });
});
