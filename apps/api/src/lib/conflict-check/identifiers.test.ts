import { describe, expect, test } from "bun:test";

import { identifierVariants } from "./identifiers";

describe("identifier variants", () => {
  test("compacts formatting and case", () => {
    expect(identifierVariants("123 456 78")).toContain("12345678");
    expect(identifierVariants("hrb 12345-b")).toContain("HRB12345B");
  });

  test("reads a Czech DIČ as its IČO and pads a shortened IČO", () => {
    expect(identifierVariants("CZ12345678")).toEqual(
      expect.arrayContaining(["CZ12345678", "12345678"]),
    );
    expect(identifierVariants("0123456")).toContain("00123456");
    expect(identifierVariants("123456")).toContain("00123456");
  });

  test("shares a key across the spellings a firm and a register use", () => {
    const shared = (left: string, right: string) =>
      identifierVariants(left).some((key) =>
        identifierVariants(right).includes(key),
      );
    expect(shared("CZ 00123456", "123456")).toBe(true);
    expect(shared("12345678", "CZ12345678")).toBe(true);
    expect(shared("12345678", "87654321")).toBe(false);
  });

  test("an identifier without letters or digits has no key", () => {
    expect(identifierVariants(" - / ")).toEqual([]);
  });
});
