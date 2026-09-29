import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { calculateLineNetAmount } from "./line-amount";

describe("line net amount", () => {
  test("multiplies a decimal quantity and rounds half up once", () => {
    expect(
      calculateLineNetAmount({
        quantity: "1.5",
        unitPriceMinor: cents(333),
      }).unwrap(),
    ).toBe(cents(500));
    expect(
      calculateLineNetAmount({
        quantity: "0.1667",
        unitPriceMinor: cents(500_000),
      }).unwrap(),
    ).toBe(cents(83_350));
  });

  test("keeps amounts above 32-bit integers exact", () => {
    expect(
      calculateLineNetAmount({
        quantity: "3",
        unitPriceMinor: cents(2 ** 31 + 1),
      }).unwrap(),
    ).toBe(cents(3 * (2 ** 31 + 1)));
  });

  test("rejects a malformed quantity or an amount past the safe range", () => {
    for (const quantity of ["-1", "1,5", "1e3", "", ".5", "01"]) {
      expect(
        calculateLineNetAmount({ quantity, unitPriceMinor: cents(1) }).isErr(),
      ).toBe(true);
    }
    expect(
      calculateLineNetAmount({
        quantity: "2",
        unitPriceMinor: cents(Number.MAX_SAFE_INTEGER),
      }).isErr(),
    ).toBe(true);
  });
});
