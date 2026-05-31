import { describe, expect, test } from "bun:test";

import {
  hasCanonicalShape,
  normalizeSiren,
  validateSiren,
  validateSiret,
} from "./validation.js";

describe("normalizeSiren", () => {
  test("strips whitespace", () => {
    expect(normalizeSiren(" 552 032 534 ")).toBe("552032534");
    expect(normalizeSiren("552032534\n")).toBe("552032534");
  });
});

describe("validateSiren", () => {
  test("accepts known-valid SIRENs", () => {
    // RENAULT SAS
    expect(validateSiren("780129987")).toBe(true);
    // DANONE
    expect(validateSiren("552032534")).toBe(true);
    // EDF
    expect(validateSiren("552081317")).toBe(true);
  });

  test("accepts SIRENs with whitespace formatting", () => {
    expect(validateSiren("780 129 987")).toBe(true);
  });

  test("rejects wrong-length / non-numeric strings", () => {
    expect(validateSiren("78012998")).toBe(false); // 8 digits
    expect(validateSiren("7801299870")).toBe(false); // 10 digits
    expect(validateSiren("")).toBe(false);
    expect(validateSiren("abcdefghi")).toBe(false);
    expect(validateSiren("78012998A")).toBe(false);
  });

  test("rejects bad Luhn checksum", () => {
    // Bump the check digit on a known-good SIREN; every adjacent
    // candidate must fail except the original.
    for (const last of "0123456789") {
      const candidate = `78012998${last}`;
      expect(validateSiren(candidate)).toBe(last === "7");
    }
  });
});

describe("validateSiret", () => {
  test("accepts known-valid SIRETs", () => {
    // RENAULT SAS head office
    expect(validateSiret("78012998704037")).toBe(true);
  });

  test("rejects wrong-length / non-numeric strings", () => {
    expect(validateSiret("7801299870403")).toBe(false); // 13 digits
    expect(validateSiret("780129987040370")).toBe(false); // 15 digits
    expect(validateSiret("")).toBe(false);
    expect(validateSiret("78012998704037X")).toBe(false);
  });

  test("rejects bad Luhn checksum", () => {
    // Bump the last digit; only the genuine SIRET should validate.
    for (const last of "0123456789") {
      const candidate = `7801299870403${last}`;
      expect(validateSiret(candidate)).toBe(last === "7");
    }
  });

  test("La Poste SIRETs validate via sum-divisible-by-5 instead of Luhn", () => {
    // La Poste's SIREN is 356000000; SIRETs under it intentionally
    // fail Luhn but satisfy "sum of all 14 digits divisible by 5".
    //
    // Build a synthetic La Poste SIRET: SIREN 356000000 + NIC 00014.
    // Digit sum = 3+5+6+0+0+0+0+0+0+0+0+0+1+4 = 19 → not divisible.
    // Try NIC 00010 → sum = 3+5+6+1 = 15 → divisible by 5.
    expect(validateSiret("35600000000010")).toBe(true);
    // Same SIRET would fail under standard Luhn:
    // confirm the carve-out is doing real work.
    expect(validateSiret("35600000000011")).toBe(false);
  });
});

describe("hasCanonicalShape", () => {
  test("accepts 9-digit and 14-digit numeric strings only", () => {
    expect(hasCanonicalShape("780129987")).toBe(true);
    expect(hasCanonicalShape("78012998704037")).toBe(true);
    // Bad-checksum SIRENs/SIRETs still pass shape-only check — by
    // design, so the dispatch routes them to lookup which raises
    // RechercheEntreprisesValidationError (HTTP 400) rather than
    // silently falling through to name-search.
    expect(hasCanonicalShape("123456789")).toBe(true);
    expect(hasCanonicalShape("12345678901234")).toBe(true);
  });

  test("rejects other lengths and non-numeric input", () => {
    expect(hasCanonicalShape("12345678")).toBe(false);
    expect(hasCanonicalShape("1234567890")).toBe(false);
    expect(hasCanonicalShape("renault")).toBe(false);
    expect(hasCanonicalShape("")).toBe(false);
  });
});
