import { describe, expect, test } from "bun:test";

import { SEARCH_SORTS } from "@stll/api-contract/search";

import {
  activeCaseLawFilterCount,
  CASE_LAW_FILTER_KEYS,
  clearedCaseLawFilters,
  createCaseLawIndexPath,
  dateRangeYear,
  decisionDateRange,
  decisionSortOrder,
  decisionSortParam,
  hasActiveCaseLawFilter,
  validDecisionDate,
  withPendingQuery,
  yearDateRange,
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
    for (const sort of SEARCH_SORTS) {
      const path = createCaseLawIndexPath({ country: "cz", q: "x", sort });
      const carried = new URL(path, "https://example.test").searchParams.get(
        "sort",
      );
      const parsed = SEARCH_SORTS.find((order) => order === carried);
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
        from: "2024-01-01",
        lang: "cs",
        q: "nájem",
        source: "nsoud",
        to: "2024-12-31",
        type: "rozsudek",
        within: '"dobré mravy"',
      }),
    ).toBe(
      "/law/cases?country=cz&court=Nejvy%C5%A1%C5%A1%C3%AD+soud&from=2024-01-01&to=2024-12-31&type=rozsudek&source=nsoud&lang=cs&q=n%C3%A1jem&within=%22dobr%C3%A9+mravy%22",
    );
  });

  test("drops a year that is not a year", () => {
    expect(createCaseLawIndexPath({ country: "cz", year: "20xx" })).toBe(
      "/law/cases?country=cz",
    );
  });

  test("an older ?year= link and its range spell the same page", () => {
    expect(createCaseLawIndexPath({ country: "cz", year: "2024" })).toBe(
      createCaseLawIndexPath({
        country: "cz",
        from: "2024-01-01",
        to: "2024-12-31",
      }),
    );
  });

  test("clearing unsets each filter key and nothing else", () => {
    const cleared = clearedCaseLawFilters();

    // Every facet key, plus the three the date range is spelled with.
    expect(Object.keys(cleared).toSorted()).toEqual(
      [...CASE_LAW_FILTER_KEYS, "from", "to", "year"].toSorted(),
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

describe("how many filters the badge reports", () => {
  test("nothing narrowing the results counts as nothing", () => {
    expect(activeCaseLawFilterCount({ country: "cz", q: "nájem" })).toBe(0);
  });

  test("each facet adds exactly one", () => {
    for (const key of CASE_LAW_FILTER_KEYS) {
      expect(activeCaseLawFilterCount({ country: "cz", [key]: "x" })).toBe(1);
    }
    expect(
      activeCaseLawFilterCount({
        country: "cz",
        ...Object.fromEntries(CASE_LAW_FILTER_KEYS.map((key) => [key, "x"])),
      }),
    ).toBe(CASE_LAW_FILTER_KEYS.length);
  });

  // One chip, one row on the rail, so one count whichever ends it names.
  test("the date span counts once, however it is spelled", () => {
    expect(
      activeCaseLawFilterCount({ country: "cz", from: "2024-01-01" }),
    ).toBe(1);
    expect(activeCaseLawFilterCount({ country: "cz", to: "2024-12-31" })).toBe(
      1,
    );
    expect(
      activeCaseLawFilterCount({
        country: "cz",
        from: "2024-01-01",
        to: "2024-12-31",
      }),
    ).toBe(1);
    expect(activeCaseLawFilterCount({ country: "cz", year: "2024" })).toBe(1);
  });

  test("the count and the yes/no answer never disagree", () => {
    for (const search of [
      { country: "cz" },
      { country: "cz", q: "nájem" },
      { country: "cz", court: "NS" },
      { country: "cz", from: "2024-01-01" },
      { country: "cz", court: "NS", lang: "cs", year: "2024" },
    ]) {
      expect(activeCaseLawFilterCount(search) > 0).toBe(
        hasActiveCaseLawFilter(search),
      );
    }
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

describe("the decision-date range", () => {
  test("a whole year is the range it means, and reads back as that year", () => {
    expect(yearDateRange("2024")).toEqual({
      from: "2024-01-01",
      to: "2024-12-31",
    });
    expect(dateRangeYear(yearDateRange("2024"))).toBe("2024");
  });

  test("part of a year, or a span across years, is no year at all", () => {
    expect(
      dateRangeYear({ from: "2024-01-01", to: "2024-06-30" }),
    ).toBeUndefined();
    expect(
      dateRangeYear({ from: "2024-01-01", to: "2025-12-31" }),
    ).toBeUndefined();
    expect(dateRangeYear({ from: "2024-01-01" })).toBeUndefined();
    expect(dateRangeYear({ to: "2024-12-31" })).toBeUndefined();
    expect(dateRangeYear({})).toBeUndefined();
  });

  test("every year round-trips through the range and back", () => {
    for (const year of ["1993", "2008", "2024", "2031"]) {
      expect(dateRangeYear(yearDateRange(year))).toBe(year);
    }
  });

  test("a bare year link resolves to that year's whole span", () => {
    expect(decisionDateRange({ year: "2024" })).toEqual({
      from: "2024-01-01",
      to: "2024-12-31",
    });
  });

  test("an explicit range wins over a year the same URL still carries", () => {
    expect(
      decisionDateRange({ from: "2024-03-01", to: "2024-03-31", year: "2019" }),
    ).toEqual({ from: "2024-03-01", to: "2024-03-31" });
  });

  test("either end may be open", () => {
    expect(decisionDateRange({ from: "2024-03-01" })).toEqual({
      from: "2024-03-01",
    });
    expect(decisionDateRange({ to: "2024-03-31" })).toEqual({
      to: "2024-03-31",
    });
    expect(decisionDateRange({})).toEqual({});
  });

  test("a bound that is not a date is dropped, not carried into the query", () => {
    expect(decisionDateRange({ from: "2024-13-01" })).toEqual({});
    expect(decisionDateRange({ from: "2024-02-30" })).toEqual({});
    expect(decisionDateRange({ from: "yesterday" })).toEqual({});
    expect(decisionDateRange({ from: "2024-1-1" })).toEqual({});
    // A dropped bound must not silently fall back to the stale year either.
    expect(decisionDateRange({ from: "2024-02-30", year: "2019" })).toEqual({
      from: "2019-01-01",
      to: "2019-12-31",
    });
  });

  test("a valid bound survives validation exactly as written", () => {
    expect(validDecisionDate("2024-02-29")).toBe("2024-02-29");
    expect(validDecisionDate("2023-02-29")).toBeUndefined();
    expect(validDecisionDate(undefined)).toBeUndefined();
  });

  test("a range counts as an active filter, however it was spelled", () => {
    expect(hasActiveCaseLawFilter({ country: "cz", year: "2024" })).toBe(true);
    expect(hasActiveCaseLawFilter({ country: "cz", to: "2024-12-31" })).toBe(
      true,
    );
    expect(hasActiveCaseLawFilter({ country: "cz", from: "nope" })).toBe(false);
  });

  test("clearing unsets both bounds and the legacy year", () => {
    const narrowed = {
      country: "cz",
      from: "2024-01-01",
      to: "2024-12-31",
      year: "2019",
    };

    expect(hasActiveCaseLawFilter(narrowed)).toBe(true);
    expect(
      hasActiveCaseLawFilter({ ...narrowed, ...clearedCaseLawFilters() }),
    ).toBe(false);
  });
});
