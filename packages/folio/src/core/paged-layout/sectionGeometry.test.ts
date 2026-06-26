import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BODY_MARGIN_PX,
  DEFAULT_HEADER_FOOTER_DISTANCE_PX,
  DEFAULT_PAGE_WIDTH_PX,
  getMargins,
  getPageSize,
  twipsToPxOr,
} from "./sectionGeometry";

describe("paged editor section geometry", () => {
  test("honors explicit zero body and header/footer margins", () => {
    const margins = getMargins({
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      headerDistance: 0,
      footerDistance: 0,
    });

    expect(margins).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      header: 0,
      footer: 0,
    });
  });

  test("defaults section offsets only when they are absent", () => {
    const margins = getMargins(null);

    expect(margins.top).toBe(DEFAULT_BODY_MARGIN_PX);
    expect(margins.header).toBe(DEFAULT_HEADER_FOOTER_DISTANCE_PX);
  });

  test("keeps page size defensive: zero size falls back to Letter", () => {
    expect(getPageSize({ pageWidth: 0, pageHeight: 0 }).w).toBe(
      DEFAULT_PAGE_WIDTH_PX,
    );
  });

  test("twipsToPxOr distinguishes explicit zero from absent offsets", () => {
    expect(twipsToPxOr(0, 96)).toBe(0);
    expect(twipsToPxOr(1440, 96)).toBe(96);
    expect(twipsToPxOr(undefined, 96)).toBe(96);
  });
});
