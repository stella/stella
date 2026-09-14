import { describe, expect, test } from "bun:test";

import { formatOrsrIdentifierSpaced } from "./identifier-format.js";

describe("formatOrsrIdentifierSpaced", () => {
  test.each([
    ["31322832", "31 322 832"],
    ["00151653", "00 151 653"],
    ["36500011", "36 500 011"],
    ["99999999", "99 999 999"],
  ])("groups the eight-digit IČO %s as dd ddd ddd", (ico, expected) => {
    expect(formatOrsrIdentifierSpaced(ico)).toBe(expected);
    expect(formatOrsrIdentifierSpaced(expected)).toBe(expected);
  });

  test.each([
    "",
    "1234567",
    "123456789",
    "31 322 832",
    "SK31322832",
    "3132283a",
    " 31322832",
    "31322832 ",
  ])("leaves %s untouched", (identifier) => {
    expect(formatOrsrIdentifierSpaced(identifier)).toBe(identifier);
  });

  test("is idempotent over every eight-digit identifier", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const ico = String(value).padStart(8, "0");
      const once = formatOrsrIdentifierSpaced(ico);
      expect(formatOrsrIdentifierSpaced(once)).toBe(once);
      expect(once.replaceAll(" ", "")).toBe(ico);
    }
  });
});
