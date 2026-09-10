import { describe, expect, test } from "bun:test";

import {
  parseCaseLawLaunchReadiness,
  publicCaseLawCountry,
} from "./case-law-launch-readiness";

const readyRow = {
  country: "CZE",
  evalSetExists: true,
  lastCensusDate: "2026-01-01",
  lastCensusGreen: true,
} as const;

describe("case-law launch readiness", () => {
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
    expect(publicCaseLawCountry("cze")).toBe("CZE");
    expect(publicCaseLawCountry("xaa")).toBeNull();
  });
});
