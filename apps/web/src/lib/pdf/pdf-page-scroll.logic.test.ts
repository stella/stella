import { describe, expect, it } from "bun:test";

import { getPDFPageScrollTop } from "@/lib/pdf/pdf-page-scroll.logic";

describe("getPDFPageScrollTop", () => {
  it("aligns a page within its existing PDF viewport", () => {
    expect(
      getPDFPageScrollTop({
        currentScrollTop: 240,
        pageTop: 620,
        viewportTop: 120,
      }),
    ).toBe(740);
  });

  it("preserves the viewport offset when the page is above it", () => {
    expect(
      getPDFPageScrollTop({
        currentScrollTop: 900,
        pageTop: 80,
        viewportTop: 180,
      }),
    ).toBe(800);
  });
});
