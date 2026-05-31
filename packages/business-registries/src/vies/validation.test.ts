import { describe, expect, test } from "bun:test";

import {
  isKnownVatCountry,
  isViesParticipant,
  knownVatCountries,
  normalizeVatNumber,
  parseVatNumber,
  validateVatFormat,
} from "./validation.js";

describe("normalizeVatNumber", () => {
  test("strips whitespace, dots, slashes and dashes; uppercases", () => {
    expect(normalizeVatNumber("de 143.593.636")).toBe("DE143593636");
    expect(normalizeVatNumber("IE-6388047V")).toBe("IE6388047V");
    expect(normalizeVatNumber("  fr 12 345678901 ")).toBe("FR12345678901");
  });
});

describe("parseVatNumber", () => {
  test("splits country prefix from national digits", () => {
    expect(parseVatNumber("DE143593636")).toEqual({
      country: "DE",
      vat: "143593636",
    });
    expect(parseVatNumber("ie 6388047v")).toEqual({
      country: "IE",
      vat: "6388047V",
    });
  });

  test("returns null when no 2-letter prefix is present", () => {
    expect(parseVatNumber("143593636")).toBeNull();
    expect(parseVatNumber("D143593636")).toBeNull();
    expect(parseVatNumber("")).toBeNull();
  });
});

describe("validateVatFormat", () => {
  test("accepts well-formed VATs across countries", () => {
    expect(validateVatFormat("DE143593636")).toBe(true);
    expect(validateVatFormat("IE6388047V")).toBe(true);
    expect(validateVatFormat("IT00159560366")).toBe(true);
    expect(validateVatFormat("FRXX123456789")).toBe(true);
    expect(validateVatFormat("ATU12345678")).toBe(true);
  });

  test("normalises punctuation before checking", () => {
    expect(validateVatFormat("DE 143.593.636")).toBe(true);
    expect(validateVatFormat(" ie-6388047v ")).toBe(true);
  });

  test("rejects unknown country prefix", () => {
    expect(validateVatFormat("ZZ123456789")).toBe(false);
  });

  test("rejects GB (removed from VIES post-Brexit)", () => {
    expect(validateVatFormat("GB123456789")).toBe(false);
  });

  test("accepts XI (Northern Ireland, still in VIES)", () => {
    expect(validateVatFormat("XI123456789")).toBe(true);
  });

  test("rejects malformed national digits per country", () => {
    // DE wants exactly 9 digits.
    expect(validateVatFormat("DE12345")).toBe(false);
    expect(validateVatFormat("DE1435936361")).toBe(false);
    // IT wants exactly 11.
    expect(validateVatFormat("IT12345")).toBe(false);
  });
});

describe("isKnownVatCountry / isViesParticipant", () => {
  test("known prefixes include all EU-27 + XI", () => {
    for (const code of ["AT", "BE", "DE", "FR", "IE", "IT", "XI"]) {
      expect(isKnownVatCountry(code)).toBe(true);
      expect(isViesParticipant(code)).toBe(true);
    }
  });

  test("GB is known but not a current participant", () => {
    expect(isKnownVatCountry("GB")).toBe(true);
    expect(isViesParticipant("GB")).toBe(false);
  });

  test("unknown codes fail both checks", () => {
    expect(isKnownVatCountry("ZZ")).toBe(false);
    expect(isViesParticipant("ZZ")).toBe(false);
  });
});

describe("knownVatCountries", () => {
  test("returns at least the 27 EU members + XI + GB", () => {
    const codes = knownVatCountries();
    // 27 current EU members, plus EL (Greece's VAT prefix), plus XI
    // and GB — 29 codes total when EL replaces GR (Greece is only
    // present as EL in the VAT scheme).
    expect(codes.length).toBeGreaterThanOrEqual(29);
    for (const code of ["AT", "BE", "BG", "CY", "CZ", "DE", "EL", "XI", "GB"]) {
      expect(codes).toContain(code);
    }
  });
});
