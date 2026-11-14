import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { lawYearSearchSchema } from "@stll/api-contract/law-year";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import {
  statuteFilterYear,
  withStatuteFilter,
} from "@/features/statutes/statute-filters.logic";
import {
  changeStatutesIndexQuery,
  readStatuteIntent,
  statutesIndexSearchSchema,
} from "@/features/statutes/statute-index-search.logic";
import { parseRouteSearch } from "@/route-search-params";

describe("statute search mode transitions", () => {
  for (const country of ["cze", "svk"]) {
    for (const validity of LEGISLATION_LIST_VALIDITIES) {
      test(`${country} drops ${validity} in full-text and leaves it cleared on returning to the list`, () => {
        const previous = v.parse(statutesIndexSearchSchema, {
          page: 3,
          pageSize: 25,
          asOf: "2027-01-01",
          q: "89/2012",
          type: "statute",
          validity,
        });
        expect(readStatuteIntent(country, previous.q).type).toBe("act");
        const fullText = changeStatutesIndexQuery({
          country,
          previous,
          query: "  contractual obligations  ",
        });
        expect(readStatuteIntent(country, fullText.q).type).toBe("text");
        expect(fullText).toEqual({
          page: undefined,
          pageSize: 25,
          asOf: "2027-01-01",
          q: "contractual obligations",
          type: "statute",
          validity: undefined,
          year: undefined,
        });
        for (const query of ["89/2012", ""]) {
          const list = changeStatutesIndexQuery({
            country,
            previous: fullText,
            query,
          });
          expect(readStatuteIntent(country, list.q).type).toBe(
            query ? "act" : "empty",
          );
          expect(list.asOf).toBe("2027-01-01");
          expect(list.validity).toBeUndefined();
          expect(list.type).toBe("statute");
          expect(list.page).toBeUndefined();
        }
      });

      test(`${country} keeps ${validity} between list queries`, () => {
        const previous = v.parse(statutesIndexSearchSchema, {
          q: "89/2012",
          validity,
        });
        for (const query of ["40/1964", ""]) {
          const next = changeStatutesIndexQuery({ country, previous, query });
          expect(next.validity).toBe(validity);
          expect(next.page).toBeUndefined();
        }
      });
    }
  }
});

describe("statute publication year search", () => {
  test("reads a plain and a quoted year link as the same year", () => {
    const plainSearch = parseRouteSearch("?year=2026");
    const quotedSearch = parseRouteSearch('?year="2026"');
    if (!("year" in plainSearch) || !("year" in quotedSearch)) {
      panic("The router omitted the year search parameter");
    }
    expect(plainSearch["year"]).toBe("2026");
    expect(quotedSearch["year"]).toBe("2026");
    expect(v.parse(lawYearSearchSchema, plainSearch["year"])).toBe("2026");
    expect(v.parse(lawYearSearchSchema, quotedSearch["year"])).toBe("2026");
  });
  test.each([1000, "1000", 2012, "2012", 9999, "9999"])(
    "normalizes a four-digit year: %j",
    (year) => {
      expect(v.parse(statutesIndexSearchSchema, { year }).year).toBe(
        String(year),
      );
    },
  );

  test.each([
    "0000",
    "0999",
    "12",
    "20120",
    "2012x",
    " 2012",
    "2026\n",
    2012.5,
    -2012,
  ])("drops a malformed publication year: %j", (year) => {
    expect(v.parse(statutesIndexSearchSchema, { year }).year).toBeUndefined();
  });

  test("preserves the publication year when a query resets pagination", () => {
    const previous = v.parse(statutesIndexSearchSchema, {
      page: 3,
      year: 2012,
    });
    for (const query of ["89/2012", ""]) {
      const next = changeStatutesIndexQuery({
        country: "cze",
        previous,
        query,
      });
      expect(next.year).toBe("2012");
      expect(next.page).toBeUndefined();
    }
  });

  test("clears the publication year when entering full-text and leaves it cleared on return", () => {
    const previous = v.parse(statutesIndexSearchSchema, { year: 2012 });
    const fullText = changeStatutesIndexQuery({
      country: "cze",
      previous,
      query: "contractual obligations",
    });
    expect(fullText.year).toBeUndefined();
    expect(
      changeStatutesIndexQuery({
        country: "cze",
        previous: fullText,
        query: "",
      }).year,
    ).toBeUndefined();
  });
});

describe("a column order across filter changes", () => {
  const sorted = v.parse(statutesIndexSearchSchema, {
    page: 2,
    year: 2012,
    order: "citedBy-desc",
  });

  test("lasts while the year does, and starts again at page one", () => {
    for (const query of ["89/2012", ""]) {
      const next = changeStatutesIndexQuery({
        country: "cze",
        previous: sorted,
        query,
      });
      expect(next.order).toBe("citedBy-desc");
      expect(next.page).toBeUndefined();
    }
  });

  test("goes with the year: removed, cleared, or left behind by full-text", () => {
    const withoutYear = [
      withStatuteFilter(sorted, "year", undefined),
      { ...sorted, year: undefined },
    ];
    for (const previous of withoutYear) {
      expect(
        changeStatutesIndexQuery({ country: "cze", previous, query: "" }).order,
      ).toBeUndefined();
    }
    expect(
      changeStatutesIndexQuery({
        country: "cze",
        previous: sorted,
        query: "contractual obligations",
      }).order,
    ).toBeUndefined();
  });

  test("a year typed in the filters keeps only a real act year", () => {
    expect(withStatuteFilter(sorted, "year", "1964").year).toBe("1964");
    for (const typed of ["12", "20120", undefined]) {
      expect(withStatuteFilter(sorted, "year", typed).year).toBeUndefined();
    }
    expect(statuteFilterYear(2012)).toBe("2012");
    expect(statuteFilterYear(999)).toBeUndefined();
    expect(statuteFilterYear(null)).toBeUndefined();
  });
});
