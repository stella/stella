import { describe, expect, it } from "bun:test";

import {
  getPDFPageScrollTop,
  isPDFSearchMatchScrollRequest,
} from "@/lib/pdf/pdf-page-scroll.logic";

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

describe("PDF search match scroll requests", () => {
  it("matches only the requested result on the requested page", () => {
    const scrollTo = {
      pageId: "page-3",
      target: { kind: "searchMatch", matchIndex: 7 },
    } as const;

    expect(
      isPDFSearchMatchScrollRequest({
        matchIndex: 7,
        pageId: "page-3",
        scrollTo,
      }),
    ).toBe(true);
    expect(
      isPDFSearchMatchScrollRequest({
        matchIndex: 6,
        pageId: "page-3",
        scrollTo,
      }),
    ).toBe(false);
    expect(
      isPDFSearchMatchScrollRequest({
        matchIndex: 7,
        pageId: "page-2",
        scrollTo,
      }),
    ).toBe(false);
  });

  it("does not consume page alignment or other overlay requests", () => {
    expect(
      isPDFSearchMatchScrollRequest({
        matchIndex: 0,
        pageId: "page-1",
        scrollTo: { pageId: "page-1" },
      }),
    ).toBe(false);
    expect(
      isPDFSearchMatchScrollRequest({
        matchIndex: 0,
        pageId: "page-1",
        scrollTo: {
          pageId: "page-1",
          target: { kind: "justification", id: "justification-1" },
        },
      }),
    ).toBe(false);
  });
});
