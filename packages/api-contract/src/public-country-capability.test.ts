import { panic } from "better-result";
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
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_SURFACE_OPEN,
  PUBLIC_LAW_DOMAINS,
  publicCountriesFor,
  publicCountryUnavailable,
  publicCountryUnavailableIn,
  publicCountryUnavailableSchema,
} from "./public-country-capability";

describe("public country availability contract", () => {
  test("advertised countries and serving lists derive from the capability map", () => {
    expect(Object.keys(PUBLIC_COUNTRY_CAPABILITIES)).toEqual(
      CASE_LAW_JURISDICTIONS,
    );
    // The serving list carries branded codes; compare the codes themselves.
    expect(PUBLIC_CASE_LAW_COUNTRIES.join(",")).toBe(
      publicCountriesFor("caseLaw", "search").join(","),
    );
    expect(PUBLIC_LEGISLATION_COUNTRIES).toEqual(
      publicCountriesFor("legislation", "search"),
    );
    expect(PUBLIC_COUNTRY_CAPABILITIES.EU).toEqual({
      caseLaw: "admitted",
      legislation: "pending_public",
    });
    expect(PUBLIC_COUNTRY_CAPABILITIES.CZE.caseLaw).toBe("admitted");
    expect(PUBLIC_COUNTRY_CAPABILITIES.HUN).toEqual({
      caseLaw: "admitted",
      legislation: "pending_public",
    });
    expect(PUBLIC_COUNTRY_CAPABILITIES.SVK).toEqual({
      caseLaw: "admitted",
      legislation: "admitted",
    });
    for (const country of PUBLIC_COUNTRIES) {
      const unavailable = publicCountryUnavailable(country, {
        domain: "caseLaw",
        surface: "search",
      });
      if (PUBLIC_COUNTRY_CAPABILITIES[country].caseLaw === "admitted") {
        expect(unavailable).toBeNull();
      } else {
        expect(
          v.parse(publicCountryUnavailableSchema, unavailable),
        ).toMatchObject({
          status: "unavailable",
          domain: "caseLaw",
          country,
          reason: PUBLIC_COUNTRY_CAPABILITIES[country].caseLaw,
        });
        expect(unavailable).not.toHaveProperty("hits");
      }
    }
  });

  test("EU case law is open on every surface while EU legislation stays closed", () => {
    for (const surface of ["identity", "pages", "search"] as const) {
      expect(publicCountriesFor("caseLaw", surface)).toContain("EU");
      expect(
        publicCountryUnavailable("EU", { domain: "caseLaw", surface }),
      ).toBeNull();
      expect(
        publicCountryUnavailable("EU", {
          domain: "legislation",
          surface,
        }),
      ).toMatchObject({ reason: "pending_public" });
    }
  });

  test("each domain answers from its own capability for every country and state pair", () => {
    const states = [
      "admitted",
      "identity_public",
      "pages_public",
      "pending_public",
      "withdrawn",
    ] as const;
    for (const country of PUBLIC_COUNTRIES) {
      for (const caseLaw of states) {
        for (const legislation of states) {
          const capabilities = {
            ...PUBLIC_COUNTRY_CAPABILITIES,
            [country]: { caseLaw, legislation },
          };
          for (const domain of PUBLIC_LAW_DOMAINS) {
            for (const surface of ["identity", "pages", "search"] as const) {
              const expected = capabilities[country][domain];
              const response = publicCountryUnavailableIn({
                capabilities,
                domain,
                input: country,
                surface,
              });
              if (PUBLIC_COUNTRY_SURFACE_OPEN[surface][expected]) {
                expect(response).toBeNull();
              } else {
                if (response === null) {
                  panic("Expected a refusal for a closed public-law domain");
                }
                expect(response).toMatchObject({
                  country,
                  domain,
                  reason: expected,
                });
                expect(
                  v.parse(publicCountryUnavailableSchema, response),
                ).toEqual(response);
              }
            }
          }
        }
      }
    }
  });

  test("an admitted case-law domain does not make a legislation refusal describe case law", () => {
    const capabilities = {
      ...PUBLIC_COUNTRY_CAPABILITIES,
      EU: { caseLaw: "admitted", legislation: "pending_public" },
    } as const;
    expect(
      publicCountryUnavailableIn({
        capabilities,
        domain: "caseLaw",
        input: "EU",
        surface: "search",
      }),
    ).toBeNull();
    expect(
      publicCountryUnavailableIn({
        capabilities,
        domain: "legislation",
        input: "EU",
        surface: "search",
      }),
    ).toMatchObject({
      domain: "legislation",
      country: "EU",
      message: "Legislation for this country is not available.",
      hint: "Choose a country with available legislation: CZE, SVK.",
    });
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
          for (const domain of PUBLIC_LAW_DOMAINS) {
            for (const surface of ["identity", "pages", "search"] as const) {
              expect(
                publicCountryUnavailable(input, { domain, surface }),
              ).toEqual(publicCountryUnavailable(country, { domain, surface }));
            }
          }
        },
      ),
    );
  });

  test("unknown countries are not advertised unavailability", () => {
    expect(
      publicCountryUnavailable("XAA", { domain: "caseLaw", surface: "search" }),
    ).toBeNull();
    expect(
      publicCountryUnavailable("XAA", { domain: "caseLaw", surface: "pages" }),
    ).toBeNull();
  });

  test("pages and search are separate lists, pages a superset of search", () => {
    expect(PUBLIC_CASE_LAW_PAGE_COUNTRIES).toEqual(
      expect.arrayContaining([...PUBLIC_CASE_LAW_COUNTRIES]),
    );
    expect(PUBLIC_LEGISLATION_PAGE_COUNTRIES).toEqual(
      publicCountriesFor("legislation", "pages"),
    );
    for (const country of PUBLIC_COUNTRIES) {
      const capability = PUBLIC_COUNTRY_CAPABILITIES[country].caseLaw;
      expect(
        publicCountriesFor("caseLaw", "pages").some((open) => open === country),
      ).toBe(PUBLIC_COUNTRY_SURFACE_OPEN.pages[capability]);
      expect(
        publicCountriesFor("caseLaw", "search").some(
          (open) => open === country,
        ),
      ).toBe(PUBLIC_COUNTRY_SURFACE_OPEN.search[capability]);
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
      SVK: { ...PUBLIC_COUNTRY_CAPABILITIES.SVK, caseLaw: "pages_public" },
    } as const;
    expect(
      publicCountryUnavailableIn({
        capabilities,
        domain: "caseLaw",
        input: "svk",
        surface: "pages",
      }),
    ).toBeNull();
    const refusal = publicCountryUnavailableIn({
      capabilities,
      domain: "caseLaw",
      input: "SVK",
      surface: "search",
    });
    expect(v.parse(publicCountryUnavailableSchema, refusal)).toMatchObject({
      status: "unavailable",
      domain: "caseLaw",
      country: "SVK",
      reason: "pages_public",
    });
    expect(refusal?.message).toBe(
      "Case-law search is not available for this country; its decision pages are.",
    );
    expect(refusal?.hint).toContain("CZE");
    expect(refusal?.hint).not.toContain("SVK");
    expect(
      publicCountryUnavailableIn({
        capabilities: {
          ...capabilities,
          SVK: { ...capabilities.SVK, caseLaw: "pending_public" },
        },
        domain: "caseLaw",
        input: "SVK",
        surface: "pages",
      }),
    ).toMatchObject({
      reason: "pending_public",
      message: "Case law for this country is not available.",
    });
  });
});
