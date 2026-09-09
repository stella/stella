import { describe, expect, test } from "bun:test";

import {
  countedSearchTotal,
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
} from "./search";

describe("search total", () => {
  test("represents counted and uncounted results without null", () => {
    expect(countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, 3)).toEqual({
      type: "exact",
      count: 3,
    });
    expect(countedSearchTotal(SEARCH_TOTAL_TYPE.ESTIMATE, 4)).toEqual({
      type: "estimate",
      count: 4,
    });
    expect(SEARCH_TOTAL_NOT_COUNTED).toEqual({ type: "not_counted" });
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "rejects invalid counts: %s",
    (count) => {
      expect(() => countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, count)).toThrow(
        "non-negative safe integer",
      );
    },
  );
});
