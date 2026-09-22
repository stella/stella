import { describe, expect, test } from "bun:test";

import {
  PUBLIC_LAW_MAX_PAGE,
  PUBLIC_LAW_PAGE_SIZES,
  DEFAULT_PUBLIC_LAW_PAGE_SIZE,
  publicLawPageIndex,
  publicLawPageNumber,
  publicLawPagesToWalk,
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPageSizeSearchValue,
  publicLawPagerModel,
  reachablePublicLawPage,
} from "./public-law-pagination.logic";

describe("what the URL is allowed to ask for", () => {
  test("a page nobody could type is the first page", () => {
    for (const value of [
      undefined,
      0,
      -3,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      PUBLIC_LAW_MAX_PAGE + 1,
      10_000,
    ]) {
      expect(publicLawPageNumber(value)).toBe(1);
    }
  });

  test("a page within the depth limit is kept", () => {
    expect(publicLawPageNumber(2)).toBe(2);
    expect(publicLawPageNumber(PUBLIC_LAW_MAX_PAGE)).toBe(PUBLIC_LAW_MAX_PAGE);
  });

  test("a size we do not offer is the default", () => {
    for (const value of [undefined, 0, 10, 51, 1000]) {
      expect(publicLawPageSize(value)).toBe(DEFAULT_PUBLIC_LAW_PAGE_SIZE);
    }
  });

  test("every offered size survives the round trip through the URL", () => {
    for (const size of PUBLIC_LAW_PAGE_SIZES) {
      expect(publicLawPageSize(publicLawPageSizeSearchValue(size))).toBe(size);
    }
  });

  test("the defaults are dropped from the URL", () => {
    expect(publicLawPageSearchValue(1)).toBeUndefined();
    expect(publicLawPageSizeSearchValue(DEFAULT_PUBLIC_LAW_PAGE_SIZE)).toBe(
      undefined,
    );
  });

  test("a page the reader walked to survives the round trip", () => {
    for (const page of [2, 7, PUBLIC_LAW_MAX_PAGE]) {
      expect(publicLawPageNumber(publicLawPageSearchValue(page))).toBe(page);
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
    expect(publicLawPagesToWalk(5, 0)).toBe(5);
    expect(publicLawPagesToWalk(PUBLIC_LAW_MAX_PAGE, 0)).toBe(
      PUBLIC_LAW_MAX_PAGE,
    );
  });

  test("a link with no page walks one page", () => {
    expect(publicLawPagesToWalk(1, 0)).toBe(1);
  });

  test("no link walks past the depth limit", () => {
    for (const page of [PUBLIC_LAW_MAX_PAGE + 1, 10_000, Number.NaN]) {
      expect(publicLawPagesToWalk(page, 0)).toBe(1);
    }
    for (let page = 1; page <= PUBLIC_LAW_MAX_PAGE + 5; page += 1) {
      expect(publicLawPagesToWalk(page, 0)).toBeLessThanOrEqual(
        PUBLIC_LAW_MAX_PAGE,
      );
    }
  });

  test("a chain the browser already walked is never shortened", () => {
    expect(publicLawPagesToWalk(1, 7)).toBe(7);
    expect(publicLawPagesToWalk(3, 7)).toBe(7);
    expect(publicLawPagesToWalk(9, 7)).toBe(9);
  });
});

describe("pages this browser can actually show", () => {
  test("a page past the walked chain falls back to its deepest page", () => {
    expect(reachablePublicLawPage(5, 2)).toBe(2);
    expect(publicLawPageIndex(5, 2)).toBe(1);
  });

  test("a cold load can only show the first page", () => {
    expect(reachablePublicLawPage(5, 0)).toBe(1);
    expect(publicLawPageIndex(5, 0)).toBe(0);
  });

  /**
   * The route redirects when the page the URL carries is not the page it can
   * serve. A URL with no page must therefore resolve to no page, whatever the
   * chain holds — otherwise every load of `/law/cases` redirects to itself.
   */
  test("a URL without a page asks for no redirect, cold chain or warm", () => {
    for (const walked of [0, 1, 5, 40]) {
      expect(
        publicLawPageSearchValue(reachablePublicLawPage(1, walked)),
      ).toBeUndefined();
    }
  });

  test("a page the chain can serve asks for no redirect either", () => {
    for (const page of [2, 3, 7]) {
      expect(publicLawPageSearchValue(reachablePublicLawPage(page, 8))).toBe(
        page,
      );
    }
  });

  test("a walked page is shown as asked", () => {
    expect(reachablePublicLawPage(3, 4)).toBe(3);
    expect(publicLawPageIndex(3, 4)).toBe(2);
  });

  test("the index always names a page the chain holds", () => {
    for (let walked = 1; walked <= 6; walked += 1) {
      for (let page = 1; page <= 10; page += 1) {
        const index = publicLawPageIndex(page, walked);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(walked);
      }
    }
  });
});

describe("what the pager offers", () => {
  test("every walked page is a direct link", () => {
    expect(
      publicLawPagerModel({ hasNextPage: true, page: 2, walkedPageCount: 3 })
        .pages,
    ).toEqual([1, 2, 3]);
  });

  test("the first page has nothing behind it", () => {
    expect(
      publicLawPagerModel({ hasNextPage: true, page: 1, walkedPageCount: 1 })
        .previousPage,
    ).toBeNull();
  });

  test("the last results have nothing after them", () => {
    expect(
      publicLawPagerModel({ hasNextPage: false, page: 3, walkedPageCount: 3 })
        .nextPage,
    ).toBeNull();
  });

  test("a step forward from the end of the chain walks one page", () => {
    expect(
      publicLawPagerModel({ hasNextPage: true, page: 3, walkedPageCount: 3 })
        .nextPage,
    ).toBe(4);
  });

  test("a step forward inside the chain needs no walking", () => {
    expect(
      publicLawPagerModel({ hasNextPage: true, page: 1, walkedPageCount: 3 })
        .nextPage,
    ).toBe(2);
  });

  test("the depth limit ends the results even when the corpus has more", () => {
    expect(
      publicLawPagerModel({
        hasNextPage: true,
        page: PUBLIC_LAW_MAX_PAGE,
        walkedPageCount: PUBLIC_LAW_MAX_PAGE,
      }).nextPage,
    ).toBeNull();
  });

  test("an empty chain still shows one page", () => {
    const model = publicLawPagerModel({
      hasNextPage: false,
      page: 1,
      walkedPageCount: 0,
    });
    expect(model.pages).toEqual([1]);
    expect(model.currentPage).toBe(1);
  });
});

/**
 * The excerpt length is not in the URL, so the router walks the default
 * length's chain and a reader who chose another one arrives on a chain holding
 * one page. The length changes neither which decisions match nor their order,
 * so page N of that chain is page N of the walked one, and walking this chain
 * to the same depth is what puts the pager back on the page the URL names.
 */
describe("a deep link on a chain the router could not walk", () => {
  const FRESH_CHAIN = 1;

  test("walking to the page the URL names puts the pager on it", () => {
    const wanted = 3;

    // What the browser walks its own chain to on arrival.
    const walked = publicLawPagesToWalk(wanted, FRESH_CHAIN);
    expect(walked).toBe(wanted);

    expect(reachablePublicLawPage(wanted, walked)).toBe(wanted);
    expect(
      publicLawPagerModel({
        hasNextPage: false,
        page: wanted,
        walkedPageCount: walked,
      }).currentPage,
    ).toBe(wanted);
    // The rows are read by index into the walked pages, so the page the pager
    // reports has to be one the chain actually holds.
    expect(publicLawPageIndex(wanted, walked)).toBe(wanted - 1);
  });

  // Without the walk this is what the reader saw: the pager clamped to the one
  // page the chain held while the URL still named a deeper one.
  test("an unwalked chain clamps the pager away from the URL's page", () => {
    expect(
      publicLawPagerModel({
        hasNextPage: false,
        page: 3,
        walkedPageCount: FRESH_CHAIN,
      }).currentPage,
    ).not.toBe(3);
  });
});
