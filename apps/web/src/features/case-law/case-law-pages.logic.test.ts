import { describe, expect, test } from "bun:test";

import { CASE_LAW_RESULT_DEPTH_MAX } from "@stll/api-contract/limits";
import {
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";

import { PUBLIC_LAW_PAGE_SIZES } from "@/components/public-law-table/public-law-pagination.logic";

import {
  CASE_LAW_MAX_PAGE,
  caseLawDeepestPage,
  caseLawPageBeforeEnd,
  caseLawPageNumber,
} from "./case-law-pages.logic";

describe("which case-law pages a request can reach", () => {
  /**
   * The API refuses `offset + limit` past the depth bound, so a page button
   * the web draws past it would be a request that can only fail.
   */
  test("the deepest page at every size ends within the depth the API serves", () => {
    for (const pageSize of PUBLIC_LAW_PAGE_SIZES) {
      const deepest = caseLawDeepestPage(pageSize);
      const offset = (deepest - 1) * pageSize;

      expect(offset + pageSize).toBeLessThanOrEqual(CASE_LAW_RESULT_DEPTH_MAX);
      // One page deeper would cross it.
      expect(offset + 2 * pageSize).toBeGreaterThan(CASE_LAW_RESULT_DEPTH_MAX);
    }
  });

  test("a URL's page is read up to the deepest page any size reaches", () => {
    expect(CASE_LAW_MAX_PAGE).toBe(
      Math.max(
        ...PUBLIC_LAW_PAGE_SIZES.map((size) => caseLawDeepestPage(size)),
      ),
    );
    expect(caseLawPageNumber(CASE_LAW_MAX_PAGE, 25)).toBe(CASE_LAW_MAX_PAGE);
  });

  test("a page past the deepest at this size is the deepest", () => {
    expect(caseLawPageNumber(CASE_LAW_MAX_PAGE, 100)).toBe(
      caseLawDeepestPage(100),
    );
  });

  test("a page nobody could type is the first", () => {
    for (const value of [undefined, 0, -1, 2.5, CASE_LAW_MAX_PAGE + 1]) {
      expect(caseLawPageNumber(value, 50)).toBe(1);
    }
  });
});

describe("where a link past the results' end lands", () => {
  test("the last page the count fills", () => {
    expect(
      caseLawPageBeforeEnd({
        emptyPage: 9,
        pageSize: 50,
        total: { type: SEARCH_TOTAL_TYPE.EXACT, count: 120 },
      }),
    ).toBe(3);
  });

  test("always before the empty page, even when the estimate overstates the results", () => {
    expect(
      caseLawPageBeforeEnd({
        emptyPage: 4,
        pageSize: 50,
        total: { type: SEARCH_TOTAL_TYPE.ESTIMATE, count: 1000 },
      }),
    ).toBe(3);
  });

  test("the first page when nothing was counted", () => {
    expect(
      caseLawPageBeforeEnd({
        emptyPage: 6,
        pageSize: 50,
        total: SEARCH_TOTAL_NOT_COUNTED,
      }),
    ).toBe(1);
  });
});
