import { describe, expect, test } from "bun:test";

import { standardVatRateOn } from "./vat-rate-period";
import { VAT_RATE_PRESETS } from "./vat-rate-presets";

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
