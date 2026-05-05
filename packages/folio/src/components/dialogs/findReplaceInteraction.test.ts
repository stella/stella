import { describe, expect, test } from "bun:test";

import {
  getAdjacentFindIndex,
  getFindEnterAction,
} from "./findReplaceInteraction";
import type { FindResult } from "./findReplaceUtils";

const emptyResult: FindResult = {
  matches: [],
  totalCount: 0,
  currentIndex: 0,
};

const matchResult: FindResult = {
  matches: [
    {
      paragraphIndex: 0,
      contentIndex: 0,
      startOffset: 0,
      endOffset: 5,
      text: "stock",
    },
  ],
  totalCount: 1,
  currentIndex: 0,
};

describe("Folio find dialog keyboard interaction", () => {
  test("reruns search when Enter follows a stale zero-result state", () => {
    expect(
      getFindEnterAction({
        searchText: "stock",
        result: emptyResult,
        shiftKey: false,
      }),
    ).toBe("search");
  });

  test("navigates only after the current query has matches", () => {
    expect(
      getFindEnterAction({
        searchText: "stock",
        result: matchResult,
        shiftKey: false,
      }),
    ).toBe("next");

    expect(
      getFindEnterAction({
        searchText: "stock",
        result: matchResult,
        shiftKey: true,
      }),
    ).toBe("previous");
  });

  test("advances through matches without resetting to the first hit", () => {
    expect(getAdjacentFindIndex(0, 107, "next")).toBe(1);
    expect(getAdjacentFindIndex(1, 107, "next")).toBe(2);
    expect(getAdjacentFindIndex(106, 107, "next")).toBe(0);
  });

  test("moves backward through matches with wraparound", () => {
    expect(getAdjacentFindIndex(2, 107, "previous")).toBe(1);
    expect(getAdjacentFindIndex(0, 107, "previous")).toBe(106);
  });
});
