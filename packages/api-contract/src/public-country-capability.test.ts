import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { CASE_LAW_JURISDICTIONS } from "./case-law-jurisdictions";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
} from "./case-law-launch-readiness";
import {
  PUBLIC_LEGISLATION_COUNTRIES,
  PUBLIC_LEGISLATION_PAGE_COUNTRIES,
} from "./legislation-publication";
import {
  ADMITTED_PUBLIC_COUNTRIES,
  PAGES_PUBLIC_COUNTRIES,
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_SURFACE_OPEN,
  publicCountryUnavailable,
  publicCountryUnavailableIn,
  publicCountryUnavailableSchema,
} from "./public-country-capability";

describe("public country availability contract", () => {
  test("advertised countries and serving lists derive from the capability map", () => {
    expect(Object.keys(PUBLIC_COUNTRY_CAPABILITIES)).toEqual(
      CASE_LAW_JURISDICTIONS,
    );
    expect(ADMITTED_PUBLIC_COUNTRIES).toEqual(PUBLIC_CASE_LAW_COUNTRIES);
    expect(PUBLIC_LEGISLATION_COUNTRIES).toEqual(ADMITTED_PUBLIC_COUNTRIES);
    expect(PUBLIC_COUNTRY_CAPABILITIES.CZE).toBe("admitted");
    expect(PUBLIC_COUNTRY_CAPABILITIES.SVK).toBe("pending_public");
    for (const country of PUBLIC_COUNTRIES) {
      const unavailable = publicCountryUnavailable(country, "search");
      if (PUBLIC_COUNTRY_CAPABILITIES[country] === "admitted") {
        expect(unavailable).toBeNull();
      } else {
        expect(
          v.parse(publicCountryUnavailableSchema, unavailable),
        ).toMatchObject({
          status: "unavailable",
          country,
          reason: PUBLIC_COUNTRY_CAPABILITIES[country],
        });
        expect(unavailable).not.toHaveProperty("hits");
      }
    }
  });

  test("public-country-capability.canonical-spelling", () => {
    assertProperty(
      "public-country-capability.canonical-spelling",
      fc.property(
        fc.constantFrom(...PUBLIC_COUNTRIES),
        fc.boolean(),
        fc.nat(8),
        (country, lower, spaces) => {
          const input =
            " ".repeat(spaces) +
            (lower ? country.toLowerCase() : country) +
            " ".repeat(spaces);
          expect(publicCountryUnavailable(input, "search")).toEqual(
            publicCountryUnavailable(country, "search"),
          );
          expect(publicCountryUnavailable(input, "pages")).toEqual(
            publicCountryUnavailable(country, "pages"),
          );
        },
      ),
    );
  });

  test("unknown countries are not advertised unavailability", () => {
    expect(publicCountryUnavailable("XAA", "search")).toBeNull();
    expect(publicCountryUnavailable("XAA", "pages")).toBeNull();
  });

  test("pages and search are separate lists, pages a superset of search", () => {
    expect(PUBLIC_CASE_LAW_PAGE_COUNTRIES).toEqual(
      expect.arrayContaining([...PUBLIC_CASE_LAW_COUNTRIES]),
    );
    expect(PUBLIC_LEGISLATION_PAGE_COUNTRIES).toEqual(PAGES_PUBLIC_COUNTRIES);
    for (const country of PUBLIC_COUNTRIES) {
      const capability = PUBLIC_COUNTRY_CAPABILITIES[country];
      expect(PAGES_PUBLIC_COUNTRIES.some((open) => open === country)).toBe(
        PUBLIC_COUNTRY_SURFACE_OPEN.pages[capability],
      );
      expect(ADMITTED_PUBLIC_COUNTRIES.some((open) => open === country)).toBe(
        PUBLIC_COUNTRY_SURFACE_OPEN.search[capability],
      );
      if (PUBLIC_COUNTRY_SURFACE_OPEN.search[capability]) {
        expect(PUBLIC_COUNTRY_SURFACE_OPEN.pages[capability]).toBe(true);
      }
    }
  });

  test("a pages-public country is open on pages and closed on search", () => {
    const capability = "pages_public";
    expect(PUBLIC_COUNTRY_SURFACE_OPEN.pages[capability]).toBe(true);
    expect(PUBLIC_COUNTRY_SURFACE_OPEN.search[capability]).toBe(false);
  });

  test("a concrete pages_public country is open on pages and refused on search", () => {
    const capabilities = {
      ...PUBLIC_COUNTRY_CAPABILITIES,
      SVK: "pages_public",
    } as const;
    expect(publicCountryUnavailableIn(capabilities, "svk", "pages")).toBeNull();
    const refusal = publicCountryUnavailableIn(capabilities, "SVK", "search");
    expect(v.parse(publicCountryUnavailableSchema, refusal)).toMatchObject({
      status: "unavailable",
      country: "SVK",
      reason: "pages_public",
    });
    expect(refusal?.message).toBe(
      "Public-law search is not available for this country; its public pages are.",
    );
    expect(refusal?.hint).toContain("CZE");
    expect(refusal?.hint).not.toContain("SVK");
    expect(
      publicCountryUnavailableIn(
        { ...capabilities, SVK: "pending_public" },
        "SVK",
        "pages",
      ),
    ).toMatchObject({
      reason: "pending_public",
      message: "Public law for this country is not available.",
    });
  });
});
