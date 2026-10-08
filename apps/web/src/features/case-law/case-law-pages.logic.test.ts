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
  caseLawLandingPage,
  caseLawPageBeforeEnd,
  caseLawPageNumber,
  caseLawPageRest,
} from "./case-law-pages.logic";

/**
 * A search whose estimate says 1,000 results while 120 exist: at 50 a page,
 * pages 1 to 3 hold rows and every page after is empty. Records each page it
 * was asked for.
 */
const overstatedSearch = () => {
  const realResults = 120;
  const pageSize = 50;
  const reads: number[] = [];
  return {
    reads,
    pageSize,
    total: { type: SEARCH_TOTAL_TYPE.ESTIMATE, count: 1000 } as const,
    rowsOn: async (page: number) => {
      reads.push(page);
      return Math.max(
        0,
        Math.min(pageSize, realResults - (page - 1) * pageSize),
      );
    },
  };
};

describe("an empty numbered jump", () => {
  test("lands on the deepest page that holds rows", async () => {
    const search = overstatedSearch();

    const landed = await caseLawLandingPage({ ...search, wanted: 8 });

    expect(landed).toBe(3);
    // Read 8, stepped back to what the count fills and further, never past
    // the page named.
    expect(search.reads.at(0)).toBe(8);
    expect(search.reads.every((page) => page <= 8)).toBe(true);
    expect(search.reads.at(-1)).toBe(3);
  });

  test("a page with rows is kept after one read", async () => {
    const search = overstatedSearch();

    expect(await caseLawLandingPage({ ...search, wanted: 2 })).toBe(2);
    expect(search.reads).toEqual([2]);
  });

  test("an outage keeps the page the link named", async () => {
    const landed = await caseLawLandingPage({
      pageSize: 50,
      rowsOn: async () => null,
      total: { type: SEARCH_TOTAL_TYPE.ESTIMATE, count: 1000 },
      wanted: 8,
    });

    expect(landed).toBe(8);
  });
});

describe("what follows the page on screen", () => {
  test("is read only from the page's own answer", () => {
    expect(caseLawPageRest({ page: { hasMore: false }, rows: "rows" })).toBe(
      "end",
    );
    expect(caseLawPageRest({ page: { hasMore: true }, rows: "rows" })).toBe(
      "more",
    );
    // Rows kept from the previous page while this one loads say nothing.
    expect(caseLawPageRest({ page: { hasMore: false }, rows: "stale" })).toBe(
      "unknown",
    );
    expect(caseLawPageRest({ page: undefined, rows: "skeleton" })).toBe(
      "unknown",
    );
  });
});

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
