import { describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import {
  defaultCaseLawCountryForLocale,
  isPublicCaseLawCountry,
  parseCaseLawLaunchReadiness,
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountryFromParam,
} from "@/features/case-law/case-law-jurisdiction";

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

  test("a listed country requires both readiness facts", () => {
    expect(() =>
      parseCaseLawLaunchReadiness([
        {
          country: "CZE",
          evalSetExists: false,
          lastCensusDate: "2026-01-01",
          lastCensusGreen: true,
        },
      ]),
    ).toThrow("Launch readiness must contain only complete entries");
    expect(() =>
      parseCaseLawLaunchReadiness([
        {
          country: "CZE",
          evalSetExists: true,
          lastCensusDate: "2026-01-01",
          lastCensusGreen: false,
        },
      ]),
    ).toThrow("Launch readiness must contain only complete entries");
  });

  test("the generated boundary rejects unsupported, repeated, and malformed rows", () => {
    expect(() =>
      parseCaseLawLaunchReadiness([
        {
          country: "XAA",
          evalSetExists: true,
          lastCensusDate: "2026-01-01",
          lastCensusGreen: true,
        },
      ]),
    ).toThrow("Launch readiness contains an unsupported country");
    expect(() =>
      parseCaseLawLaunchReadiness([
        {
          country: "CZE",
          evalSetExists: true,
          lastCensusDate: "2026-01-01",
          lastCensusGreen: true,
        },
        {
          country: "CZE",
          evalSetExists: true,
          lastCensusDate: "2026-01-02",
          lastCensusGreen: true,
        },
      ]),
    ).toThrow("Launch readiness countries must be unique and sorted");
    expect(() =>
      parseCaseLawLaunchReadiness([
        {
          country: "CZE",
          evalSetExists: true,
          lastCensusDate: "01/02/2026",
          lastCensusGreen: true,
        },
      ]),
    ).toThrow("Launch readiness must contain only complete entries");
  });
});
