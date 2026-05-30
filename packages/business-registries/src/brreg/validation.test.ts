import { describe, expect, test } from "bun:test";

import { normalizeOrgnr, validateOrgnr } from "./validation.js";

describe("normalizeOrgnr", () => {
  test("strips spaces and dashes", () => {
    expect(normalizeOrgnr("974 760 673")).toBe("974760673");
    expect(normalizeOrgnr("974-760-673")).toBe("974760673");
    expect(normalizeOrgnr(" 974760673 ")).toBe("974760673");
  });
});

describe("validateOrgnr", () => {
  test("accepts known-valid orgnr", () => {
    // 974760673 = Brønnøysundregistrene itself
    expect(validateOrgnr("974760673")).toBe(true);
    // 923609016 = Equinor ASA
    expect(validateOrgnr("923609016")).toBe(true);
  });

  test("rejects orgnr with bad checksum", () => {
    expect(validateOrgnr("974760674")).toBe(false);
    expect(validateOrgnr("123456789")).toBe(false);
  });

  test("rejects non-9-digit inputs", () => {
    expect(validateOrgnr("12345678")).toBe(false);
    expect(validateOrgnr("1234567890")).toBe(false);
    expect(validateOrgnr("97476067a")).toBe(false);
    expect(validateOrgnr("")).toBe(false);
  });

  test("accepts orgnr after normalization", () => {
    expect(validateOrgnr("974 760 673")).toBe(true);
  });
});
