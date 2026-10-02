import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { CASE_LAW_JURISDICTIONS } from "./case-law-jurisdictions";
import { PUBLIC_CASE_LAW_COUNTRIES } from "./case-law-launch-readiness";
import { PUBLIC_LEGISLATION_COUNTRIES } from "./legislation-publication";
import {
  ADMITTED_PUBLIC_COUNTRIES,
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  publicCountryUnavailable,
  publicCountryUnavailableSchema,
} from "./public-country-capability";

describe("public country availability contract", () => {
  test("advertised countries and serving lists derive from the capability map", () => {
    expect(CASE_LAW_JURISDICTIONS).toEqual(
      Object.keys(PUBLIC_COUNTRY_CAPABILITIES),
    );
    expect(PUBLIC_CASE_LAW_COUNTRIES).toEqual(ADMITTED_PUBLIC_COUNTRIES);
    expect(PUBLIC_LEGISLATION_COUNTRIES).toEqual(ADMITTED_PUBLIC_COUNTRIES);
    expect(PUBLIC_COUNTRY_CAPABILITIES.CZE).toBe("admitted");
    expect(PUBLIC_COUNTRY_CAPABILITIES.SVK).toBe("pending_public");
    for (const country of PUBLIC_COUNTRIES) {
      const unavailable = publicCountryUnavailable(country);
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
          expect(publicCountryUnavailable(input)).toEqual(
            publicCountryUnavailable(country),
          );
        },
      ),
    );
  });

  test("unknown countries are not advertised unavailability", () => {
    expect(publicCountryUnavailable("XAA")).toBeNull();
  });
});
