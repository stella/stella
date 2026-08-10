import { describe, expect, test } from "bun:test";

import { COUNTRY_CODES, isCountryCode } from "./codes.js";

describe("COUNTRY_CODES", () => {
  test("contains every entry exactly once", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  test("every entry is a two-letter uppercase string", () => {
    for (const code of COUNTRY_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/u);
    }
  });
});

describe("isCountryCode", () => {
  test("accepts the non-ISO Kosovo code used by supported data sources", () => {
    expect(isCountryCode("XK")).toBe(true);
  });

  test("rejects unknown, malformed, or non-string inputs", () => {
    expect(isCountryCode("ZZ")).toBe(false);
    expect(isCountryCode("cz")).toBe(false);
    expect(isCountryCode("CZE")).toBe(false);
    expect(isCountryCode("")).toBe(false);
    expect(isCountryCode(undefined)).toBe(false);
    expect(isCountryCode(null)).toBe(false);
    expect(isCountryCode(42)).toBe(false);
  });
});
