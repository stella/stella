import { describe, expect, test } from "bun:test";

import { normalizeCompanyNumber, validateCompanyNumber } from "./validation.js";

describe("normalizeCompanyNumber", () => {
  test("uppercases and strips whitespace", () => {
    expect(normalizeCompanyNumber("  sc012345  ")).toBe("SC012345");
    expect(normalizeCompanyNumber("sc 012345")).toBe("SC012345");
    expect(normalizeCompanyNumber("ni012345")).toBe("NI012345");
  });

  test("zero-pads numeric-only CRNs to 8 digits", () => {
    expect(normalizeCompanyNumber("445790")).toBe("00445790");
    expect(normalizeCompanyNumber("00445790")).toBe("00445790");
    expect(normalizeCompanyNumber("1")).toBe("00000001");
  });

  test("zero-pads prefixed CRNs to 6 digits after the prefix", () => {
    expect(normalizeCompanyNumber("SC1234")).toBe("SC001234");
    expect(normalizeCompanyNumber("OC1")).toBe("OC000001");
    expect(normalizeCompanyNumber("LP12")).toBe("LP000012");
  });

  test("preserves canonical 8-character CRNs unchanged", () => {
    expect(normalizeCompanyNumber("12345678")).toBe("12345678");
    expect(normalizeCompanyNumber("SC123456")).toBe("SC123456");
  });

  test("returns the upper-cased input verbatim for unknown shapes", () => {
    expect(normalizeCompanyNumber("not a crn")).toBe("NOTACRN");
    expect(normalizeCompanyNumber("123456789")).toBe("123456789");
  });
});

describe("validateCompanyNumber", () => {
  test("accepts canonical 8-character numeric CRNs", () => {
    expect(validateCompanyNumber("00445790")).toBe(true);
    expect(validateCompanyNumber("445790")).toBe(true);
    expect(validateCompanyNumber("12345678")).toBe(true);
  });

  test("accepts two-letter prefix + 6 digits", () => {
    expect(validateCompanyNumber("SC012345")).toBe(true);
    expect(validateCompanyNumber("NI012345")).toBe(true);
    expect(validateCompanyNumber("OC123456")).toBe(true);
    expect(validateCompanyNumber("LP000001")).toBe(true);
    expect(validateCompanyNumber("RC000001")).toBe(true);
    expect(validateCompanyNumber("FC123456")).toBe(true);
  });

  test("accepts case-insensitive input", () => {
    expect(validateCompanyNumber("sc012345")).toBe(true);
    expect(validateCompanyNumber("ni012345")).toBe(true);
  });

  test("rejects more than 8 characters", () => {
    expect(validateCompanyNumber("123456789")).toBe(false);
    expect(validateCompanyNumber("SC1234567")).toBe(false);
  });

  test("rejects non-alphanumeric input", () => {
    expect(validateCompanyNumber("abc")).toBe(false);
    expect(validateCompanyNumber("SC-12345")).toBe(false);
    expect(validateCompanyNumber("")).toBe(false);
  });

  test("rejects single-letter prefix", () => {
    expect(validateCompanyNumber("S1234567")).toBe(false);
  });

  test("rejects the reserved all-zero CRN", () => {
    expect(validateCompanyNumber("00000000")).toBe(false);
    expect(validateCompanyNumber("0")).toBe(false);
  });
});
