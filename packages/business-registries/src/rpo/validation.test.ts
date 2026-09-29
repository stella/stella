import { describe, expect, test } from "bun:test";

import { validateIco } from "../orsr/validation.js";
import { isIcoShape, normalizeIco } from "./validation.js";

describe("isIcoShape", () => {
  test("accepts eight digits after stripping separators", () => {
    expect(normalizeIco("31 333-532")).toBe("31333532");
    expect(isIcoShape("31 333 532")).toBe(true);
    expect(isIcoShape("00397865")).toBe(true);
  });

  test("accepts registered IČOs that fail the MOD-11 check", () => {
    expect(validateIco("11111111")).toBe(false);
    expect(isIcoShape("11111111")).toBe(true);
  });

  test("rejects other lengths and non-digits", () => {
    for (const input of ["3133353", "313335322", "abcdefgh", ""]) {
      expect(isIcoShape(input)).toBe(false);
    }
  });
});
