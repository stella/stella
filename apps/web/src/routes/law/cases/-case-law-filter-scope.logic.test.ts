import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { normalizeCaseLawCountryFilters } from "@stll/api-contract/case-law-filter-scope";

import { parseRouteSearch } from "@/route-search-params";

import { correctedCaseLawFilterSearch } from "./-case-law-filter-scope.logic";
import { searchSchema } from "./-case-law-search-schema";

const CZE_COURT = "Ústavní soud";
const SVK_COURT = "Ústavný súd SR";
const SOURCE_ID = "00000000-0000-4000-8000-000000000001";

const countriesByCourt = new Map([
  [CZE_COURT, ["CZE"]],
  [SVK_COURT, ["SVK"]],
]);

const validate = (
  search: v.InferOutput<typeof searchSchema>,
  country: string,
) =>
  normalizeCaseLawCountryFilters({
    country,
    filters: search,
    countriesByField: {
      court:
        search.court === undefined
          ? []
          : (countriesByCourt.get(search.court) ?? []),
      lang: ["CZE"],
      type: ["CZE", "SVK"],
      sourceId: ["CZE"],
    },
  });

describe("case-list country filter correction", () => {
  test("normalizes a shared Czech URL carrying a Slovak court while retaining the date range", () => {
    const url = new URL(
      "https://my.stll.app/law/cases?court=%C3%9Astavn%C3%BD+s%C3%BAd+SR&from=2026-01-01&to=2026-12-31&country=cze",
    );
    const search = v.parse(searchSchema, parseRouteSearch(url.search));
    expect(
      correctedCaseLawFilterSearch({
        search,
        country: "CZE",
        validation: validate(search, "CZE"),
      }),
    ).toMatchObject({
      country: "cze",
      court: undefined,
      from: "2026-01-01",
      to: "2026-12-31",
      filterNotice: [{ field: "court", value: SVK_COURT, countries: ["SVK"] }],
    });
  });

  test.each([
    { court: CZE_COURT, country: "SVK", origin: "CZE" },
    { court: SVK_COURT, country: "CZE", origin: "SVK" },
  ])(
    "switching to $country removes the $origin court and resets pagination with a notice",
    ({ court, country, origin }) => {
      const search = v.parse(searchSchema, {
        court,
        country: country.toLowerCase(),
        page: "3",
        q: "contract",
      });
      const corrected = correctedCaseLawFilterSearch({
        search,
        country,
        validation: validate(search, country),
      });
      expect(corrected).toMatchObject({
        country: country.toLowerCase(),
        court: undefined,
        q: "contract",
        page: undefined,
        filterNotice: [{ field: "court", value: court, countries: [origin] }],
      });
      expect(corrected).not.toBeNull();
      if (corrected === null) {
        return;
      }
      expect(
        correctedCaseLawFilterSearch({
          search: corrected,
          country,
          validation: validate(corrected, country),
        }),
      ).toBeNull();
    },
  );

  test("retains valid Czech filters and page without a correction", () => {
    const search = v.parse(searchSchema, {
      country: "cze",
      court: CZE_COURT,
      lang: "cs",
      type: "rozsudek",
      sourceId: SOURCE_ID,
      page: "2",
    });
    const validation = validate(search, "CZE");
    expect(validation.filters).toEqual({
      court: CZE_COURT,
      lang: "cs",
      type: "rozsudek",
      sourceId: SOURCE_ID,
    });
    expect(
      correctedCaseLawFilterSearch({ search, country: "CZE", validation }),
    ).toBeNull();
  });

  test("drops only facets outside the selected vocabulary and names every removal", () => {
    const search = v.parse(searchSchema, {
      country: "svk",
      court: SVK_COURT,
      lang: "cs",
      type: "rozsudek",
      sourceId: SOURCE_ID,
    });
    const corrected = correctedCaseLawFilterSearch({
      search,
      country: "SVK",
      validation: validate(search, "SVK"),
    });
    expect(corrected).toMatchObject({
      court: SVK_COURT,
      type: "rozsudek",
      lang: undefined,
      sourceId: undefined,
      filterNotice: [
        { field: "lang", value: "cs", countries: ["CZE"] },
        { field: "sourceId", value: SOURCE_ID, countries: ["CZE"] },
      ],
    });
  });
});
