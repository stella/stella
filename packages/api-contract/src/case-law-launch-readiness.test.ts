import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_BROWSER_COUNTRIES,
  CASE_LAW_LAUNCH_EXCEPTIONS,
  CASE_LAW_REGION_BY_COUNTRY,
  parseCaseLawLaunchReadiness,
  publicCaseLawCountry,
  validateCaseLawLaunchAdmission,
} from "./case-law-launch-readiness";

const readyRow = {
  country: "CZE",
  evalSetExists: true,
  lastCensusDate: "2026-01-01",
  lastCensusGreen: true,
} as const;

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

  test("admits a country with a serving receipt", () => {
    expect(
      validateCaseLawLaunchAdmission({
        admitted: ["CZE"],
        exceptions: {},
        receipts: parseCaseLawLaunchReadiness([readyRow]),
      }),
    ).toEqual(["CZE"]);
  });

  test("admits a country with a recorded exception", () => {
    expect(
      validateCaseLawLaunchAdmission({
        admitted: ["POL"],
        exceptions: CASE_LAW_LAUNCH_EXCEPTIONS,
        receipts: [],
      }),
    ).toEqual(["POL"]);
  });

  test("rejects a country with both a serving receipt and an exception", () => {
    expect(() =>
      validateCaseLawLaunchAdmission({
        admitted: ["POL"],
        exceptions: CASE_LAW_LAUNCH_EXCEPTIONS,
        receipts: parseCaseLawLaunchReadiness([
          { ...readyRow, country: "POL" },
        ]),
      }),
    ).toThrow("cannot have both a serving receipt and a launch exception");
  });

  test("rejects an exception for a non-admitted country", () => {
    expect(() =>
      validateCaseLawLaunchAdmission({
        admitted: ["CZE"],
        exceptions: CASE_LAW_LAUNCH_EXCEPTIONS,
        receipts: parseCaseLawLaunchReadiness([readyRow]),
      }),
    ).toThrow("cannot name a non-admitted country");
  });

  test("pins the recorded launch exception set", () => {
    expect(Object.keys(CASE_LAW_LAUNCH_EXCEPTIONS)).toEqual(["POL"]);
  });
});
