import { expect, test } from "bun:test";

import {
  CASE_LAW_SCOPED_FILTER_FIELDS,
  normalizeCaseLawCountryFilters,
} from "./case-law-filter-scope";

const countriesByField = {
  court: ["SVK"],
  lang: ["SVK"],
  type: ["CZE", "SVK"],
  sourceId: ["SVK"],
};

test("switching country retains exactly the filters belonging to that country and normalizes to a fixed point", () => {
  const filters = {
    court: "Ústavný súd SR",
    lang: "sk",
    type: "judgment",
    sourceId: "00000000-0000-4000-8000-000000000000",
  };
  for (const country of ["CZE", "SVK"]) {
    const normalized = normalizeCaseLawCountryFilters({
      country,
      filters,
      countriesByField,
    });
    for (const field of CASE_LAW_SCOPED_FILTER_FIELDS) {
      expect(normalized.filters[field] === filters[field]).toBe(
        countriesByField[field].includes(country),
      );
    }
    expect(
      normalizeCaseLawCountryFilters({
        country,
        filters: normalized.filters,
        countriesByField,
      }),
    ).toEqual({ filters: normalized.filters, removed: [] });
  }
});

test("a Slovak court arriving in a Czech search is removed with its country as an explicit correction", () => {
  expect(
    normalizeCaseLawCountryFilters({
      country: "cze",
      filters: { court: "Ústavný súd SR" },
      countriesByField,
    }),
  ).toEqual({
    filters: {},
    removed: [{ field: "court", value: "Ústavný súd SR", countries: ["SVK"] }],
  });
});

test("blank filters are absent regardless of corpus vocabulary", () => {
  for (const field of CASE_LAW_SCOPED_FILTER_FIELDS) {
    expect(
      normalizeCaseLawCountryFilters({
        country: "SVK",
        filters: { [field]: "" },
        countriesByField,
      }),
    ).toEqual({ filters: {}, removed: [] });
  }
});
