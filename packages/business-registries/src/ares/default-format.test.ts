import { describe, expect, test } from "bun:test";

import { formatAresIdentifierSpaced } from "./default-format.js";

describe("formatAresIdentifierSpaced", () => {
  test.each([
    ["27082440", "270 82 440"],
    ["00000001", "000 00 001"],
    ["99999999", "999 99 999"],
  ])("groups the eight-digit IČO %s as ddd dd ddd", (ico, expected) => {
    expect(formatAresIdentifierSpaced(ico)).toBe(expected);
    expect(formatAresIdentifierSpaced(expected)).toBe(expected);
  });

  test.each([
    "",
    "1234567",
    "123456789",
    "270 82 440",
    "CZ27082440",
    "2708244a",
    " 27082440",
    "27082440 ",
  ])("leaves %s untouched", (identifier) => {
    expect(formatAresIdentifierSpaced(identifier)).toBe(identifier);
  });

  test("is idempotent over every eight-digit identifier", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const ico = String(value).padStart(8, "0");
      const once = formatAresIdentifierSpaced(ico);
      expect(formatAresIdentifierSpaced(once)).toBe(once);
      expect(once.replaceAll(" ", "")).toBe(ico);
    }
  });
});
