import { describe, expect, test } from "bun:test";

import type { Layout } from "../core/layout-engine/types";
import {
  getPageScrollTarget,
  isValidPmScrollPosition,
} from "./scrollNavigation";

const layout = {
  pages: [
    {
      number: 1,
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
      size: { w: 816, h: 1056 },
      fragments: [
        {
          kind: "paragraph",
          blockId: "p1",
          x: 72,
          y: 72,
          width: 672,
          height: 24,
          fromLine: 0,
          toLine: 1,
          pmStart: 4,
          pmEnd: 20,
        },
      ],
    },
    {
      number: 2,
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
      size: { w: 816, h: 1056 },
      fragments: [],
    },
  ],
} satisfies Layout;

describe("paged editor scroll navigation", () => {
  test("uses the first fragment position for page navigation", () => {
    expect(getPageScrollTarget(layout, 1)).toEqual({
      type: "position",
      pmPos: 4,
    });
  });

  test("falls back to the page shell when a page has no positioned content", () => {
    expect(getPageScrollTarget(layout, 2)).toEqual({
      type: "pageShell",
      pageIndex: 1,
    });
  });

  test("rejects invalid page numbers", () => {
    expect(getPageScrollTarget(layout, 0)).toBeNull();
    expect(getPageScrollTarget(layout, 1.5)).toBeNull();
    expect(getPageScrollTarget(layout, 3)).toBeNull();
    expect(getPageScrollTarget(null, 1)).toBeNull();
  });

  test("rejects non-document positions before querying the DOM", () => {
    expect(isValidPmScrollPosition(0)).toBe(true);
    expect(isValidPmScrollPosition(42)).toBe(true);
    expect(isValidPmScrollPosition(-1)).toBe(false);
    expect(isValidPmScrollPosition(1.5)).toBe(false);
    expect(isValidPmScrollPosition(Number.NaN)).toBe(false);
  });
});
