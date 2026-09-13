import { describe, expect, test } from "bun:test";

import {
  DECISION_MAX_PAGE,
  DECISION_PAGE_SIZES,
  DEFAULT_DECISION_PAGE_SIZE,
  decisionPageIndex,
  decisionPageNumber,
  decisionPagesToWalk,
  decisionPageSearchValue,
  decisionPageSize,
  decisionPageSizeSearchValue,
  decisionPagerModel,
  reachableDecisionPage,
} from "./decision-pagination.logic";

describe("what the URL is allowed to ask for", () => {
  test("a page nobody could type is the first page", () => {
    for (const value of [
      undefined,
      0,
      -3,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      DECISION_MAX_PAGE + 1,
      10_000,
    ]) {
      expect(decisionPageNumber(value)).toBe(1);
    }
  });

  test("a page within the depth limit is kept", () => {
    expect(decisionPageNumber(2)).toBe(2);
    expect(decisionPageNumber(DECISION_MAX_PAGE)).toBe(DECISION_MAX_PAGE);
  });

  test("a size we do not offer is the default", () => {
    for (const value of [undefined, 0, 10, 51, 1000]) {
      expect(decisionPageSize(value)).toBe(DEFAULT_DECISION_PAGE_SIZE);
    }
  });

  test("every offered size survives the round trip through the URL", () => {
    for (const size of DECISION_PAGE_SIZES) {
      expect(decisionPageSize(decisionPageSizeSearchValue(size))).toBe(size);
    }
  });

  test("the defaults are dropped from the URL", () => {
    expect(decisionPageSearchValue(1)).toBeUndefined();
    expect(decisionPageSizeSearchValue(DEFAULT_DECISION_PAGE_SIZE)).toBe(
      undefined,
    );
  });

  test("a page the reader walked to survives the round trip", () => {
    for (const page of [2, 7, DECISION_MAX_PAGE]) {
      expect(decisionPageNumber(decisionPageSearchValue(page))).toBe(page);
    }
  });
});

describe("how deep a load walks the chain", () => {
  /**
   * A shared link, a reload, a new tab and a crawler all arrive cold. Walking
   * only the first page would make every page but the first unshareable, which
   * is the opposite of what the pager's real links promise.
   */
  test("a cold load walks to the page the link names", () => {
    expect(decisionPagesToWalk(5, 0)).toBe(5);
    expect(decisionPagesToWalk(DECISION_MAX_PAGE, 0)).toBe(DECISION_MAX_PAGE);
  });

  test("a link with no page walks one page", () => {
    expect(decisionPagesToWalk(1, 0)).toBe(1);
  });

  test("no link walks past the depth limit", () => {
    for (const page of [DECISION_MAX_PAGE + 1, 10_000, Number.NaN]) {
      expect(decisionPagesToWalk(page, 0)).toBe(1);
    }
    for (let page = 1; page <= DECISION_MAX_PAGE + 5; page += 1) {
      expect(decisionPagesToWalk(page, 0)).toBeLessThanOrEqual(
        DECISION_MAX_PAGE,
      );
    }
  });

  test("a chain the browser already walked is never shortened", () => {
    expect(decisionPagesToWalk(1, 7)).toBe(7);
    expect(decisionPagesToWalk(3, 7)).toBe(7);
    expect(decisionPagesToWalk(9, 7)).toBe(9);
  });
});

describe("pages this browser can actually show", () => {
  test("a page past the walked chain falls back to its deepest page", () => {
    expect(reachableDecisionPage(5, 2)).toBe(2);
    expect(decisionPageIndex(5, 2)).toBe(1);
  });

  test("a cold load can only show the first page", () => {
    expect(reachableDecisionPage(5, 0)).toBe(1);
    expect(decisionPageIndex(5, 0)).toBe(0);
  });

  /**
   * The route redirects when the page the URL carries is not the page it can
   * serve. A URL with no page must therefore resolve to no page, whatever the
   * chain holds — otherwise every load of `/law/cases` redirects to itself.
   */
  test("a URL without a page asks for no redirect, cold chain or warm", () => {
    for (const walked of [0, 1, 5, 40]) {
      expect(
        decisionPageSearchValue(reachableDecisionPage(1, walked)),
      ).toBeUndefined();
    }
  });

  test("a page the chain can serve asks for no redirect either", () => {
    for (const page of [2, 3, 7]) {
      expect(decisionPageSearchValue(reachableDecisionPage(page, 8))).toBe(
        page,
      );
    }
  });

  test("a walked page is shown as asked", () => {
    expect(reachableDecisionPage(3, 4)).toBe(3);
    expect(decisionPageIndex(3, 4)).toBe(2);
  });

  test("the index always names a page the chain holds", () => {
    for (let walked = 1; walked <= 6; walked += 1) {
      for (let page = 1; page <= 10; page += 1) {
        const index = decisionPageIndex(page, walked);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(walked);
      }
    }
  });
});

describe("what the pager offers", () => {
  test("every walked page is a direct link", () => {
    expect(
      decisionPagerModel({ hasNextPage: true, page: 2, walkedPageCount: 3 })
        .pages,
    ).toEqual([1, 2, 3]);
  });

  test("the first page has nothing behind it", () => {
    expect(
      decisionPagerModel({ hasNextPage: true, page: 1, walkedPageCount: 1 })
        .previousPage,
    ).toBeNull();
  });

  test("the last results have nothing after them", () => {
    expect(
      decisionPagerModel({ hasNextPage: false, page: 3, walkedPageCount: 3 })
        .nextPage,
    ).toBeNull();
  });

  test("a step forward from the end of the chain walks one page", () => {
    expect(
      decisionPagerModel({ hasNextPage: true, page: 3, walkedPageCount: 3 })
        .nextPage,
    ).toBe(4);
  });

  test("a step forward inside the chain needs no walking", () => {
    expect(
      decisionPagerModel({ hasNextPage: true, page: 1, walkedPageCount: 3 })
        .nextPage,
    ).toBe(2);
  });

  test("the depth limit ends the results even when the corpus has more", () => {
    expect(
      decisionPagerModel({
        hasNextPage: true,
        page: DECISION_MAX_PAGE,
        walkedPageCount: DECISION_MAX_PAGE,
      }).nextPage,
    ).toBeNull();
  });

  test("an empty chain still shows one page", () => {
    const model = decisionPagerModel({
      hasNextPage: false,
      page: 1,
      walkedPageCount: 0,
    });
    expect(model.pages).toEqual([1]);
    expect(model.currentPage).toBe(1);
  });
});
