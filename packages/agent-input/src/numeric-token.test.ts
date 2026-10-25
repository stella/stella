import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { parseDecimalToken, parseIntegerToken } from "./numeric-token";

describe("whole numeric tokens", () => {
  test.each([
    "12junk",
    "",
    " 1",
    "1 ",
    "1\n",
    "1e3",
    "0x10",
    "+1",
    "1_000",
    "NaN",
    "Infinity",
    Number.NaN,
    Infinity,
    null,
    undefined,
  ])("refuses non-tokens: %j", (token) => {
    expect(parseIntegerToken(token).isErr()).toBe(true);
    expect(parseDecimalToken(token).isErr()).toBe(true);
  });

  test("integers are safe and optionally unsigned or range-bounded", () => {
    for (const n of [
      0,
      12,
      -12,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ]) {
      expect(parseIntegerToken(String(n)).unwrap()).toBe(n);
    }
    expect(Object.is(parseIntegerToken("-0").unwrap(), -0)).toBe(true);
    expect(parseIntegerToken("-0", { sign: "unsigned" }).isErr()).toBe(true);
    expect(parseIntegerToken("9007199254740992").isErr()).toBe(true);
    expect(parseIntegerToken("1.0").isErr()).toBe(true);
    expect(parseIntegerToken("4", { min: 4, max: 4 }).unwrap()).toBe(4);
    expect(parseIntegerToken("3", { min: 4 }).isErr()).toBe(true);
    expect(parseIntegerToken("5", { max: 4 }).isErr()).toBe(true);
    expect(parseIntegerToken("-1", { sign: "unsigned" }).isErr()).toBe(true);
  });

  test("decimals require digits on both sides of an optional point and stay finite", () => {
    expect(parseDecimalToken("12.5").unwrap()).toBe(12.5);
    expect(parseDecimalToken("-0.25").unwrap()).toBe(-0.25);
    expect(parseDecimalToken(".5").isErr()).toBe(true);
    expect(parseDecimalToken("1.").isErr()).toBe(true);
    expect(parseDecimalToken("1,5").isErr()).toBe(true);
    expect(parseDecimalToken("9".repeat(400)).isErr()).toBe(true);
    expect(parseDecimalToken("-1.5", { sign: "unsigned" }).isErr()).toBe(true);
    expect(parseDecimalToken("1.5", { min: 1, max: 2 }).unwrap()).toBe(1.5);
    expect(parseDecimalToken("0.5", { min: 1 }).isErr()).toBe(true);
    expect(parseDecimalToken("2.5", { max: 2 }).isErr()).toBe(true);
  });

  test("safe integer tokens round-trip", () => {
    assertProperty(
      "safe integer tokens round-trip",
      fc.property(
        fc.integer({
          min: Number.MIN_SAFE_INTEGER,
          max: Number.MAX_SAFE_INTEGER,
        }),
        (n) => expect(parseIntegerToken(String(n)).unwrap()).toBe(n),
      ),
    );
  });

  test("unsigned integer tokens reject every non-digit spelling", () => {
    assertProperty(
      "unsigned integer tokens reject every non-digit spelling",
      fc.property(
        fc.string().filter((token) => /[^0-9]/u.test(token)),
        (token) =>
          expect(parseIntegerToken(token, { sign: "unsigned" }).isErr()).toBe(
            true,
          ),
      ),
    );
  });
});
