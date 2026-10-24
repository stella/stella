import { describe, expect, test } from "bun:test";

import { standardVatRateOn } from "./vat-rate-period";
import { VAT_RATE_PRESETS, vatRatePeriodsForCountry } from "./vat-rate-presets";

describe("VAT rate presets", () => {
  test("periods for each code do not overlap", () => {
    for (const rates of Object.values(VAT_RATE_PRESETS)) {
      for (const rate of rates) {
        const overlaps = rates.filter(
          (candidate) =>
            candidate.code === rate.code &&
            candidate.validFrom < (rate.validTo ?? "9999-12-31") &&
            rate.validFrom < (candidate.validTo ?? "9999-12-31"),
        );
        expect(overlaps).toHaveLength(1);
      }
    }
  });

  test("resolves the Slovak standard rate across the 2025 boundary", () => {
    expect(standardVatRateOn(VAT_RATE_PRESETS.SK, "2024-12-31")).toBe(2000);
    expect(standardVatRateOn(VAT_RATE_PRESETS.SK, "2025-01-01")).toBe(2300);
  });

  test("resolves the Slovak standard rate across the 2011 boundary (zákon 222/2004 Z. z. § 27)", () => {
    expect(standardVatRateOn(VAT_RATE_PRESETS.SK, "2010-12-31")).toBe(1900);
    expect(standardVatRateOn(VAT_RATE_PRESETS.SK, "2011-01-01")).toBe(2000);
  });

  test("resolves the Czech standard rate after the 2024 change (zákon 235/2004 Sb. § 47 odst. 1)", () => {
    expect(standardVatRateOn(VAT_RATE_PRESETS.CZ, "2023-12-31")).toBe(2100);
    expect(standardVatRateOn(VAT_RATE_PRESETS.CZ, "2024-01-01")).toBe(2100);
  });
});

describe("VAT rates for a seller's country", () => {
  const bothPresets = [...VAT_RATE_PRESETS.SK, ...VAT_RATE_PRESETS.CZ];
  const custom = {
    code: "office-standard",
    name: "Own 18 %",
    rateBps: 1800,
    validFrom: "2020-01-01",
    validTo: null,
  };

  test("a Czech seller resolves 21 % although Slovak presets are installed too", () => {
    expect(
      standardVatRateOn(
        vatRatePeriodsForCountry(bothPresets, "CZ"),
        "2026-10-19",
      ),
    ).toBe(2100);
  });

  test("a Slovak seller resolves 23 % although Czech presets are installed too", () => {
    expect(
      standardVatRateOn(
        vatRatePeriodsForCountry(bothPresets, "SK"),
        "2026-10-19",
      ),
    ).toBe(2300);
  });

  test("hand-entered rates apply to every country; presets only to their own", () => {
    const periods = [...bothPresets, custom];
    expect(vatRatePeriodsForCountry(periods, "EU")).toEqual([custom]);
    expect(vatRatePeriodsForCountry(periods, "CZ")).toEqual([
      ...VAT_RATE_PRESETS.CZ,
      custom,
    ]);
  });

  test("a hand-entered rate with a country-like prefix is not a preset", () => {
    const slovakLooking = { ...custom, code: "sk-office" };
    const czechLooking = { ...custom, code: "cz-reduced-office" };
    const periods = [...bothPresets, slovakLooking, czechLooking];
    expect(vatRatePeriodsForCountry(periods, "CZ")).toEqual([
      ...VAT_RATE_PRESETS.CZ,
      slovakLooking,
      czechLooking,
    ]);
    expect(vatRatePeriodsForCountry(periods, "EU")).toEqual([
      slovakLooking,
      czechLooking,
    ]);
  });
});
