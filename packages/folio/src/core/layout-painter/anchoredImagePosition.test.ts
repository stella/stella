// eigenpal #424 (positionV/H align): regression tests for body anchored
// image positioning. Mirrors upstream's PageGeometry math so center align
// and relativeFrom variants resolve to the correct (x, y) on the page.

import { describe, expect, test } from "bun:test";

import type { ImageRun, ImageRunPosition } from "../layout-engine/types";
import { resolveAnchoredImagePosition } from "./renderPage";

const PAGE = {
  pageWidth: 816,
  pageHeight: 1056,
  marginLeft: 96,
  marginTop: 72,
  marginRight: 96,
  marginBottom: 72,
} as const;

const CONTENT_WIDTH = PAGE.pageWidth - PAGE.marginLeft - PAGE.marginRight; // 624
const CONTENT_HEIGHT = PAGE.pageHeight - PAGE.marginTop - PAGE.marginBottom; // 912

const IMG_W = 200;
const IMG_H = 150;

const fragmentY = 300;

const baseRun = (position: ImageRunPosition | undefined): ImageRun => ({
  kind: "image",
  src: "img.png",
  width: IMG_W,
  height: IMG_H,
  wrapType: "square",
  displayMode: "float",
  ...(position ? { position } : {}),
});

describe("resolveAnchoredImagePosition — horizontal align (eigenpal #424)", () => {
  test("align='center' relativeFrom='margin' centers within content width", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin", align: "center" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.x).toBe((CONTENT_WIDTH - IMG_W) / 2); // 212
  });

  test("align='center' relativeFrom='page' centers across the full page width (offset by -marginLeft)", () => {
    const run = baseRun({
      horizontal: { relativeTo: "page", align: "center" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // Painter coordinates start at the content origin; page center sits at
    // pageWidth/2 - marginLeft = 408 - 96 = 312 from the content origin.
    // Image x is therefore (pageWidth - IMG_W) / 2 - marginLeft.
    expect(result.x).toBe((PAGE.pageWidth - IMG_W) / 2 - PAGE.marginLeft); // 212
  });

  test("align='right' relativeFrom='page' anchors to the page's right edge", () => {
    const run = baseRun({
      horizontal: { relativeTo: "page", align: "right" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // pageWidth - IMG_W - marginLeft = 816 - 200 - 96 = 520
    expect(result.x).toBe(PAGE.pageWidth - IMG_W - PAGE.marginLeft);
    expect(result.side).toBe("right");
  });

  test("align='left' relativeFrom='page' anchors to the page's left edge (negative content-relative x)", () => {
    const run = baseRun({
      horizontal: { relativeTo: "page", align: "left" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.x).toBe(-PAGE.marginLeft); // -96
  });

  test("align='inside' aliases left within the content band", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin", align: "inside" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.x).toBe(0);
  });

  test("align='outside' aliases right within the content band", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin", align: "outside" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.x).toBe(CONTENT_WIDTH - IMG_W); // 424
    expect(result.side).toBe("right");
  });

  test("bare positionH (no align, no offset) anchors at the band origin", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.x).toBe(0);
  });
});

describe("resolveAnchoredImagePosition — vertical align (eigenpal #424)", () => {
  test("align='center' relativeFrom='page' centers vertically across the page", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "page", align: "center" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // Page center in content-relative coords:
    // (pageHeight - IMG_H) / 2 - marginTop = (1056 - 150) / 2 - 72 = 381
    expect(result.y).toBe((PAGE.pageHeight - IMG_H) / 2 - PAGE.marginTop);
  });

  test("align='center' relativeFrom='margin' centers within content height", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "margin", align: "center" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.y).toBe((CONTENT_HEIGHT - IMG_H) / 2); // 381
  });

  test("align='bottom' relativeFrom='page' anchors to the page bottom", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "page", align: "bottom" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // pageHeight - IMG_H - marginTop = 1056 - 150 - 72 = 834
    expect(result.y).toBe(PAGE.pageHeight - IMG_H - PAGE.marginTop);
  });

  test("relativeFrom='topMargin' anchors above the content area (negative content-relative y)", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "topMargin", align: "top" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.y).toBe(-PAGE.marginTop); // -72
  });

  test("relativeFrom='bottomMargin' anchors at the bottom of the content area", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "bottomMargin", align: "top" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.y).toBe(CONTENT_HEIGHT); // 912
  });

  test("relativeFrom='topMargin' with posOffset shifts down from the top margin strip", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      // 914400 EMU = 1 inch = 96 px
      vertical: { relativeTo: "topMargin", posOffset: 914_400 },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // baseY = -marginTop = -72; +96px offset → 24
    expect(result.y).toBe(-PAGE.marginTop + 96);
  });

  test("align='center' relativeFrom='paragraph' falls back to the paragraph anchor (no band)", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "paragraph", align: "center" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // Paragraph/line have no band height — falling back to the paragraph
    // anchor keeps Word-like behaviour (centered against an undefined band
    // would otherwise jump to the page top).
    expect(result.y).toBe(fragmentY);
  });

  test("bare positionV with relativeFrom='page' anchors at the page top (band origin)", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "page" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.y).toBe(-PAGE.marginTop);
  });

  test("bare positionV with relativeFrom='paragraph' keeps the paragraph anchor", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.y).toBe(fragmentY);
  });
});

describe("resolveAnchoredImagePosition — back-compat with posOffset (eigenpal #424)", () => {
  test("horizontal posOffset against page is translated by -marginLeft", () => {
    const run = baseRun({
      // 1 inch offset from page edge = 96 px
      horizontal: { relativeTo: "page", posOffset: 914_400 },
      vertical: { relativeTo: "paragraph" },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    // baseX = -marginLeft = -96, +96 offset = 0 (right at the content origin)
    expect(result.x).toBe(0);
  });

  test("vertical posOffset against paragraph adds to fragmentY", () => {
    const run = baseRun({
      horizontal: { relativeTo: "margin" },
      vertical: { relativeTo: "paragraph", posOffset: 914_400 },
    });
    const result = resolveAnchoredImagePosition(run, fragmentY, {
      contentWidth: CONTENT_WIDTH,
      contentHeight: CONTENT_HEIGHT,
      ...PAGE,
    });
    expect(result.y).toBe(fragmentY + 96);
  });
});
