import { describe, expect, test } from "bun:test";

import {
  getAdjacentSearchMatchIndex,
  getCenteredSearchMatchScrollTop,
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
});
