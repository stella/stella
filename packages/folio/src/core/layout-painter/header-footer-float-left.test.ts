/**
 * Header/footer anchored-object horizontal positioning. A text box (or image)
 * anchored centered relative to the page must resolve to a centered `left`, not
 * be pinned to the container's left edge. Regression for
 * eigenpal/docx-editor#700.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveHeaderFooterFloatLeft,
  type HeaderFooterLayoutInfo,
} from "./renderPage";

const layout: HeaderFooterLayoutInfo = {
  flowTop: 50,
  flowLeft: 100,
  contentWidth: 400,
  pageWidth: 612,
  pageHeight: 792,
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
};

describe("resolveHeaderFooterFloatLeft", () => {
  test("no position → pinned left", () => {
    expect(resolveHeaderFooterFloatLeft(200, undefined, layout)).toBe("0");
  });

  test("center relative to page → centered on the page, in container coords", () => {
    // (pageWidth 612 - width 200) / 2 - flowLeft 100 = 106
    expect(
      resolveHeaderFooterFloatLeft(
        200,
        { relativeTo: "page", align: "center" },
        layout,
      ),
    ).toBe("106px");
  });

  test("right relative to page", () => {
    // 612 - 200 - 100 = 312
    expect(
      resolveHeaderFooterFloatLeft(
        200,
        { relativeTo: "page", align: "right" },
        layout,
      ),
    ).toBe("312px");
  });

  test("center without page anchor → centered in the content/margin box", () => {
    // (contentWidth 400 - 200) / 2 = 100
    expect(resolveHeaderFooterFloatLeft(200, { align: "center" }, layout)).toBe(
      "100px",
    );
  });
});
