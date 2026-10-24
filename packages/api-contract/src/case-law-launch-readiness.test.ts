import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_BROWSER_COUNTRIES,
  CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES,
  CASE_LAW_EXPLICIT_LAUNCHES,
  CASE_LAW_REGION_BY_COUNTRY,
  parseCaseLawLaunchReadiness,
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "./case-law-launch-readiness";

const readyRow = {
  country: "CZE",
  evalSetExists: true,
  lastCensusDate: "2026-01-01",
  lastCensusGreen: true,
} as const;

describe("explicit case-law launches", () => {
  test("the explicit launch set is exactly Poland", () => {
    expect(CASE_LAW_EXPLICIT_LAUNCH_COUNTRIES).toEqual(["POL"]);
    expect(CASE_LAW_EXPLICIT_LAUNCHES.POL.decidedOn).toMatch(
      /^\d{4}-\d{2}-\d{2}$/u,
    );
  });

  test("an explicitly launched country is admitted to search", () => {
    expect(PUBLIC_CASE_LAW_COUNTRIES.some((country) => country === "POL")).toBe(
      true,
    );
  });
});

describe("case-law launch readiness", () => {
  test.each(CASE_LAW_BROWSER_COUNTRIES)(
    "%s has a region and can carry complete readiness evidence",
    (country) => {
      expect(CASE_LAW_REGION_BY_COUNTRY[country]).toMatch(/^[A-Z]{2}$/u);
      const parsed = parseCaseLawLaunchReadiness([{ ...readyRow, country }]);
      expect(parsed).toHaveLength(1);
      expect(parsed.at(0) === country).toBe(true);
    },
  );

  test("requires complete readiness evidence", () => {
    expect(() =>
      parseCaseLawLaunchReadiness([{ ...readyRow, evalSetExists: false }]),
    ).toThrow("Launch readiness must contain only complete entries");
    expect(() =>
      parseCaseLawLaunchReadiness([{ ...readyRow, lastCensusGreen: false }]),
    ).toThrow("Launch readiness must contain only complete entries");
    expect(() =>
      parseCaseLawLaunchReadiness([{ ...readyRow, extra: true }]),
    ).toThrow("Launch readiness must contain only complete entries");
  });

  test.each(["2026-02-30", "1900-02-29", "0000-01-01"])(
    "requires an existing CE census day %s",
    (lastCensusDate) => {
      expect(() =>
        parseCaseLawLaunchReadiness([{ ...readyRow, lastCensusDate }]),
      ).toThrow("Launch readiness must contain only complete entries");
    },
  );

  test("requires canonical, sorted, unique countries and ISO dates", () => {
    expect(() =>
      parseCaseLawLaunchReadiness([{ ...readyRow, country: "xaa" }]),
    ).toThrow("Launch readiness must contain only complete entries");
    expect(() =>
      parseCaseLawLaunchReadiness([{ ...readyRow, country: "XAA" }]),
    ).toThrow("Launch readiness must contain only complete entries");
    expect(() =>
      parseCaseLawLaunchReadiness([
        readyRow,
        { ...readyRow, lastCensusDate: "2026-01-02" },
      ]),
    ).toThrow("Launch readiness countries must be unique and sorted");
    expect(() =>
      parseCaseLawLaunchReadiness([
        { ...readyRow, lastCensusDate: "01/02/2026" },
      ]),
    ).toThrow("Launch readiness must contain only complete entries");
  });

  test("admits only a country in the checked-in list", () => {
    expect(publicCaseLawCountry("cze")).toBe(publicCaseLawCountry("CZE"));
    expect(publicCaseLawCountry("xaa")).toBeNull();
  });
});
