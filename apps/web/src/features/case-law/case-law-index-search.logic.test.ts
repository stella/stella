import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_FILTER_KEYS,
  clearedCaseLawFilters,
  createCaseLawIndexPath,
  DECISION_SORT_ORDERS,
  decisionSortOrder,
  decisionSortParam,
  hasActiveCaseLawFilter,
  withPendingQuery,
} from "@/features/case-law/case-law-index-search.logic";

describe("the sort the URL carries", () => {
  test("omits the default so one result set has one address", () => {
    expect(decisionSortParam(undefined)).toBeUndefined();
    expect(decisionSortParam("relevance")).toBeUndefined();
    expect(createCaseLawIndexPath({ country: "cz", q: "nájem" })).toBe(
      "/law/cases?country=cz&q=n%C3%A1jem",
    );
    expect(
      createCaseLawIndexPath({ country: "cz", q: "nájem", sort: "relevance" }),
    ).toBe("/law/cases?country=cz&q=n%C3%A1jem");
  });

  test("carries a non-default sort", () => {
    expect(decisionSortParam("newest")).toBe("newest");
    expect(
      createCaseLawIndexPath({ country: "cz", q: "nájem", sort: "newest" }),
    ).toBe("/law/cases?country=cz&q=n%C3%A1jem&sort=newest");
  });

  test("runs a search whose URL says nothing under the default", () => {
    expect(decisionSortOrder(undefined)).toBe("relevance");
    expect(decisionSortOrder("newest")).toBe("newest");
  });

  test("every sort survives a round trip through the URL", () => {
    for (const sort of DECISION_SORT_ORDERS) {
      const path = createCaseLawIndexPath({ country: "cz", q: "x", sort });
      const carried = new URL(path, "https://example.test").searchParams.get(
        "sort",
      );
      const parsed = DECISION_SORT_ORDERS.find((order) => order === carried);
      expect(decisionSortOrder(parsed)).toBe(sort);
    }
  });
});

describe("the filters the URL carries", () => {
  test("writes every filter it was given", () => {
    expect(
      createCaseLawIndexPath({
        country: "cz",
        court: "Nejvyšší soud",
        lang: "cs",
        q: "nájem",
        source: "nsoud",
        type: "rozsudek",
        year: "2024",
      }),
    ).toBe(
      "/law/cases?country=cz&court=Nejvy%C5%A1%C5%A1%C3%AD+soud&year=2024&type=rozsudek&source=nsoud&lang=cs&q=n%C3%A1jem",
    );
  });

  test("drops a year that is not a year", () => {
    expect(createCaseLawIndexPath({ country: "cz", year: "20xx" })).toBe(
      "/law/cases?country=cz",
    );
  });

  test("clearing unsets each filter key and nothing else", () => {
    const cleared = clearedCaseLawFilters();

    expect(Object.keys(cleared).toSorted()).toEqual(
      [...CASE_LAW_FILTER_KEYS].toSorted(),
    );
    expect(Object.values(cleared)).toEqual(
      CASE_LAW_FILTER_KEYS.map(() => undefined),
    );
    expect(
      hasActiveCaseLawFilter({ country: "cz", q: "nájem", ...cleared }),
    ).toBe(false);
  });

  test("each filter on its own counts as active", () => {
    for (const key of CASE_LAW_FILTER_KEYS) {
      expect(hasActiveCaseLawFilter({ country: "cz", [key]: "x" })).toBe(true);
    }
  });

  test("a query alone is not a filter", () => {
    expect(hasActiveCaseLawFilter({ country: "cz", q: "nájem" })).toBe(false);
  });
});

describe("a query edit still pending when something else changes", () => {
  test("carries the typed text into the change instead of losing it", () => {
    expect(
      withPendingQuery({ country: "cz", q: "nájem" }, "nájem bytu"),
    ).toEqual({ country: "cz", q: "nájem bytu" });
  });

  test("leaves the URL alone when no write is pending", () => {
    const previous = { country: "cz", q: "nájem" } as const;

    expect(withPendingQuery(previous, null)).toBe(previous);
  });

  test("clears the query when the field was emptied", () => {
    expect(withPendingQuery({ country: "cz", q: "nájem" }, "   ")).toEqual({
      country: "cz",
      q: undefined,
    });
  });

  test("keeps every other field of the URL", () => {
    expect(
      withPendingQuery(
        { country: "cz", court: "Nejvyšší soud", sort: "newest" },
        "nájem",
      ),
    ).toEqual({
      country: "cz",
      court: "Nejvyšší soud",
      sort: "newest",
      q: "nájem",
    });
  });
});
