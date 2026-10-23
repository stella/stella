import { describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import {
  caseLawCountryRegion,
  isPublicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountryFromParam,
  publicCaseLawPageCountryFromParam,
} from "@/features/case-law/case-law-jurisdiction";
import { defaultCaseLawCountryForLocale } from "@/lib/case-law-route";

describe("case-law launch readiness", () => {
  test("every locale defaults to a launch-ready country", () => {
    for (const locale of UI_LOCALES) {
      const country = defaultCaseLawCountryForLocale(locale);
      expect(country).not.toBeNull();
      expect(country !== null && isPublicCaseLawCountry(country)).toBe(true);
    }
  });

  test("route params resolve only countries in the generated list", () => {
    for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
      expect(publicCaseLawCountryFromParam(country.toLowerCase())).toBe(
        country,
      );
    }
    expect(publicCaseLawCountryFromParam("all")).toBeNull();
    expect(publicCaseLawCountryFromParam("xaa")).toBeNull();
    expect(publicCaseLawCountryFromParam(undefined)).toBeNull();
  });

  test("every listed country is supported by the browser", () => {
    for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
      expect(caseLawCountryRegion(country)).not.toBeNull();
    }
  });

  test("identity-only EU decisions do not open search or public pages", () => {
    expect(publicCaseLawCountryFromParam("eu")).toBeNull();
    expect(publicCaseLawPageCountryFromParam("eu")).toBeNull();
  });
});
