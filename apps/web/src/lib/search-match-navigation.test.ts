import { describe, expect, test } from "bun:test";

import {
  getAdjacentSearchMatchIndex,
  getCenteredSearchMatchScrollTop,
  getSettledSearchMatchSummary,
} from "@/lib/search-match-navigation";

describe("search preview match navigation", () => {
  test("wraps in both directions", () => {
    expect(
      getAdjacentSearchMatchIndex({
        activeIndex: 2,
        direction: "next",
        matchCount: 3,
      }),
    ).toBe(0);
    expect(
      getAdjacentSearchMatchIndex({
        activeIndex: 0,
        direction: "previous",
        matchCount: 3,
      }),
    ).toBe(2);
  });

  test("keeps an empty result at index zero", () => {
    expect(
      getAdjacentSearchMatchIndex({
        activeIndex: 4,
        direction: "next",
        matchCount: 0,
      }),
    ).toBe(0);
  });

  test("centres a match within its own scroll viewport", () => {
    expect(
      getCenteredSearchMatchScrollTop({
        containerHeight: 400,
        containerTop: 100,
        currentScrollTop: 200,
        matchHeight: 20,
        matchTop: 500,
      }),
    ).toBe(410);
  });

  test("distinguishes a pending search from a settled search with no matches", () => {
    expect(
      getSettledSearchMatchSummary({ isSettled: false, result: undefined }),
    ).toBeNull();
    expect(
      getSettledSearchMatchSummary({ isSettled: true, result: null }),
    ).toEqual({ count: 0, truncated: false });
  });

  test("summarizes a settled bounded result", () => {
    expect(
      getSettledSearchMatchSummary({
        isSettled: true,
        result: { matches: [{}, {}], truncated: true },
      }),
    ).toEqual({ count: 2, truncated: true });
  });
});
