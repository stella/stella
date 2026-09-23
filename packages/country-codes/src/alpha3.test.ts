import { describe, expect, test } from "bun:test";

import {
  COUNTRY_ALPHA3_BY_CODE,
  COUNTRY_ALPHA3_CODES,
  countryCodeFromAlpha3,
  isCountryAlpha3Code,
} from "./alpha3.js";
import { COUNTRY_CODES } from "./codes.js";

describe("COUNTRY_ALPHA3_BY_CODE", () => {
  test("covers every alpha-2 code exactly once", () => {
    expect(Object.keys(COUNTRY_ALPHA3_BY_CODE).toSorted()).toEqual(
      [...COUNTRY_CODES].toSorted(),
    );
  });

  test("every entry is a three-letter uppercase string", () => {
    for (const alpha3 of COUNTRY_ALPHA3_CODES) {
      expect(alpha3).toMatch(/^[A-Z]{3}$/u);
    }
  });

  // The reverse lookup is a Map, so a collision would silently drop a country
  // rather than fail to build.
  test("assigns a distinct alpha-3 to every country", () => {
    expect(new Set(COUNTRY_ALPHA3_CODES).size).toBe(
      COUNTRY_ALPHA3_CODES.length,
    );
  });

  test("spells the codes the standard assigns", () => {
    expect(COUNTRY_ALPHA3_BY_CODE.CZ).toBe("CZE");
    expect(COUNTRY_ALPHA3_BY_CODE.SK).toBe("SVK");
    expect(COUNTRY_ALPHA3_BY_CODE.PL).toBe("POL");
    expect(COUNTRY_ALPHA3_BY_CODE.AT).toBe("AUT");
    expect(COUNTRY_ALPHA3_BY_CODE.DE).toBe("DEU");
    // Codes that do not follow from the alpha-2 spelling.
    expect(COUNTRY_ALPHA3_BY_CODE.CH).toBe("CHE");
    expect(COUNTRY_ALPHA3_BY_CODE.GB).toBe("GBR");
    expect(COUNTRY_ALPHA3_BY_CODE.NL).toBe("NLD");
    expect(COUNTRY_ALPHA3_BY_CODE.SI).toBe("SVN");
    expect(COUNTRY_ALPHA3_BY_CODE.HR).toBe("HRV");
  });

  test("gives Kosovo the code its data sources use", () => {
    expect(COUNTRY_ALPHA3_BY_CODE.XK).toBe("XKX");
  });
});

describe("countryCodeFromAlpha3", () => {
  test("round-trips every country", () => {
    for (const code of COUNTRY_CODES) {
      expect(countryCodeFromAlpha3(COUNTRY_ALPHA3_BY_CODE[code])).toBe(code);
    }
  });

  test("rejects unknown and non-canonical spellings", () => {
    expect(countryCodeFromAlpha3("ZZZ")).toBeNull();
    expect(countryCodeFromAlpha3("cze")).toBeNull();
    expect(countryCodeFromAlpha3("CZ")).toBeNull();
    expect(countryCodeFromAlpha3("")).toBeNull();
  });
});

describe("isCountryAlpha3Code", () => {
  test("accepts canonical alpha-3 codes only", () => {
    expect(isCountryAlpha3Code("CZE")).toBe(true);
    expect(isCountryAlpha3Code("XKX")).toBe(true);
    expect(isCountryAlpha3Code("CZ")).toBe(false);
    expect(isCountryAlpha3Code("cze")).toBe(false);
    expect(isCountryAlpha3Code(undefined)).toBe(false);
    expect(isCountryAlpha3Code(null)).toBe(false);
    expect(isCountryAlpha3Code(42)).toBe(false);
  });
});
