import { describe, expect, test } from "bun:test";
import { formatCurrencyAmount, formatCurrencyCompact } from "./format-currency";

describe("formatCurrencyAmount", () => {
  test("formats currency using standard system by default", () => {
    const result = formatCurrencyAmount(10000000, "USD");
    // Standard USD format: $100,000.00
    expect(result).toBe("$100,000.00");
  });

  test("formats currency using en-IN lakhs/crores system for Indian organizations", () => {
    // Test USD formatting under IN jurisdiction
    const usdResult = formatCurrencyAmount(10000000, "USD", "IN");
    expect(usdResult).toBe("$1,00,000.00");

    // Test INR formatting under IN jurisdiction
    const inrResult = formatCurrencyAmount(10000000, "INR", "IN");
    expect(inrResult).toBe("₹1,00,000.00");

    // Test compact formatting (0 decimal digits)
    const compactResult = formatCurrencyCompact(10000000, "INR", "IN");
    expect(compactResult).toBe("₹1,00,000");
  });
});
