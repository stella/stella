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
  isStrictSearch,
  STRICT_SEARCH_VALUE,
  strictSearchValue,
  validDecisionDate,
  withPendingQuery,
  withQuery,
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

describe("the strict search the URL carries", () => {
  test("writes the one spelling a link uses, and reads it back", () => {
    const path = createCaseLawIndexPath({
      country: "cz",
      q: "jak vypovědět nájem",
      strict: STRICT_SEARCH_VALUE,
    });

    expect(path).toBe(
      "/law/cases?country=cz&q=jak+vypov%C4%9Bd%C4%9Bt+n%C3%A1jem&strict=1",
    );
    const carried = new URL(path, "https://example.test").searchParams.get(
      "strict",
    );
    expect(isStrictSearch(strictSearchValue(carried ?? undefined))).toBe(true);
  });

  test("the default search keeps one address", () => {
    expect(strictSearchValue(undefined)).toBeUndefined();
    expect(isStrictSearch(undefined)).toBe(false);
    expect(
      createCaseLawIndexPath({ country: "cz", q: "nájem", strict: undefined }),
    ).toBe(createCaseLawIndexPath({ country: "cz", q: "nájem" }));
  });

  // A public link may be typed or crawled: any other spelling is the search
  // everyone gets by default, not an error screen.
  test("a spelling the link never writes is the default search", () => {
    for (const value of ["true", "0", "yes", "1 ", ""]) {
      expect(strictSearchValue(value)).toBeUndefined();
      expect(isStrictSearch(strictSearchValue(value))).toBe(false);
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
        to: "2024-12-31",
        type: "rozsudek",
      }),
    ).toBe(
      "/law/cases?country=cz&court=Nejvy%C5%A1%C5%A1%C3%AD+soud&from=2024-01-01&to=2024-12-31&type=rozsudek&lang=cs&q=n%C3%A1jem",
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

  // One chip, one row in the popover, so one count whichever ends it names.
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

describe("a query edit", () => {
  // Requiring every word is asked for beside one query's results, and the
  // reader is offered no way back. Carried into the next query it would keep
  // answering nothing, with nothing on screen to say why.
  test("drops the strict search it was asked of", () => {
    expect(
      withQuery(
        {
          country: "cz",
          q: "jak vypovědět nájem",
          strict: STRICT_SEARCH_VALUE,
        },
        "výpověď nájmu",
      ),
    ).toEqual({ country: "cz", q: "výpověď nájmu", strict: undefined });
  });

  test("drops it when the box is emptied too", () => {
    expect(
      withQuery({ country: "cz", q: "nájem", strict: STRICT_SEARCH_VALUE }, ""),
    ).toEqual({ country: "cz", q: undefined, strict: undefined });
  });

  // The link that turns strict matching on runs through this same transition,
  // so text that did not change must not cancel the choice being made of it.
  test("keeps it while the query text stands", () => {
    const previous = {
      country: "cz",
      q: "nájem",
      strict: STRICT_SEARCH_VALUE,
    } as const;

    expect(withQuery(previous, "nájem")).toBe(previous);
  });

  test("keeps every other field of the URL", () => {
    expect(
      withQuery(
        { country: "cz", court: "Nejvyšší soud", from: "2024-01-01" },
        "nájem",
      ),
    ).toEqual({
      country: "cz",
      court: "Nejvyšší soud",
      from: "2024-01-01",
      q: "nájem",
      strict: undefined,
    });
  });
});

describe("the question columns a search carries", () => {
  const questions = ["col_a", "col_b"];
  const searches = [
    { country: "cz", q: "nájem", questions },
    { country: "cz", q: "nájem", court: "Nejvyšší soud", questions },
    { country: "sk", q: undefined, sort: "newest", questions },
    { country: "cz", q: "nájem", strict: STRICT_SEARCH_VALUE, questions },
  ] as const;
  const queries = ["nájem", "výpověď nájmu", "", "  ", "nájem bytu"];

  // A new query is a new search: the columns picked for the last topic would
  // otherwise follow the reader into an unrelated one.
  test("a changed query starts without them, an unchanged one keeps them", () => {
    for (const previous of searches) {
      for (const query of queries) {
        const next = withQuery(
          { ...previous, questions: [...questions] },
          query,
        );
        const queryChanged = next.q !== previous.q;

        expect(next.questions).toEqual(queryChanged ? undefined : questions);
      }
    }
  });

  // No write pending means the change is a filter, sort, page or strict step
  // on the same topic, which keeps them.
  test("a change with no query edit pending keeps them", () => {
    for (const previous of searches) {
      const next = withPendingQuery(
        { ...previous, questions: [...questions] },
        null,
      );

      expect(next.questions).toEqual(questions);
    }
  });

  test("the canonical address never names them", () => {
    for (const search of searches) {
      expect(
        createCaseLawIndexPath({ ...search, questions: [...questions] }),
      ).not.toContain("questions");
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
      strict: undefined,
    });
  });

  // A filter applied while the box holds text the URL has not seen is still a
  // query edit, so it drops the strict search the previous query was asked of.
  test("drops the strict search along with the text it was asked of", () => {
    expect(
      withPendingQuery(
        { country: "cz", q: "nájem", strict: STRICT_SEARCH_VALUE },
        "nájem bytu",
      ),
    ).toEqual({ country: "cz", q: "nájem bytu", strict: undefined });
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
