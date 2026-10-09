import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import {
  changeStatutesIndexQuery,
  readStatuteIntent,
  statutesIndexSearchSchema,
} from "@/features/statutes/statute-index-search.logic";
import { lawYearSearchSchema } from "@/lib/legal/law-year-search";

describe("statute search mode transitions", () => {
  for (const country of ["cze", "svk"]) {
    for (const validity of LEGISLATION_LIST_VALIDITIES) {
      test(`${country} drops ${validity} in full-text and leaves it cleared on returning to the list`, () => {
        const previous = v.parse(statutesIndexSearchSchema, {
          page: 3,
          pageSize: 25,
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
  test("normalizes numeric router search and quoted string search to the same year", () => {
    const numericSearch = defaultParseSearch("?year=2026");
    const stringSearch = defaultParseSearch('?year="2026"');
    expect(numericSearch.year).toBe(2026);
    expect(stringSearch.year).toBe("2026");
    expect(v.parse(lawYearSearchSchema, numericSearch.year)).toBe("2026");
    expect(v.parse(lawYearSearchSchema, stringSearch.year)).toBe("2026");
  });
  test.each([2012, "2012"])("normalizes a four-digit year: %j", (year) => {
    expect(v.parse(statutesIndexSearchSchema, { year }).year).toBe("2012");
  });

  test.each(["12", "20120", "2012x", " 2012", "2026\n", 2012.5, -2012])(
    "rejects a malformed publication year: %j",
    (year) => {
      expect(v.safeParse(statutesIndexSearchSchema, { year }).success).toBe(
        false,
      );
    },
  );

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
