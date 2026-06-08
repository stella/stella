import { describe, expect, test } from "bun:test";

import { evaluateNumericExpression } from "./compute.js";

const evalExpr = (expression: string, data: Record<string, unknown> = {}) =>
  evaluateNumericExpression(expression, data);

describe("evaluateNumericExpression — arithmetic", () => {
  test("respects operator precedence and parentheses", () => {
    expect(evalExpr("2 + 3 * 4")).toBe(14);
    expect(evalExpr("(2 + 3) * 4")).toBe(20);
    expect(evalExpr("10 - 2 - 3")).toBe(5); // left-associative
    expect(evalExpr("2 * 3 + 4 * 5")).toBe(26);
    expect(evalExpr("17 % 5")).toBe(2);
  });

  test("handles unary minus and decimals/underscores", () => {
    expect(evalExpr("-5 + 2")).toBe(-3);
    expect(evalExpr("-(2 + 3)")).toBe(-5);
    expect(evalExpr("1_000 * 1.5")).toBe(1500);
  });
});

describe("evaluateNumericExpression — variables", () => {
  test("resolves dotted paths and coerces numeric strings", () => {
    expect(evalExpr("rent * 12", { rent: 2500 })).toBe(30_000);
    expect(evalExpr("a.b + 1", { a: { b: 41 } })).toBe(42);
    expect(evalExpr("rent + 1", { rent: "2499" })).toBe(2500); // form strings
  });

  test("returns undefined for a missing or non-numeric variable", () => {
    expect(evalExpr("rent * 2", {})).toBeUndefined();
    expect(evalExpr("rent * 2", { rent: "n/a" })).toBeUndefined();
  });
});

describe("evaluateNumericExpression — functions", () => {
  test("min / max / abs / floor / ceil", () => {
    expect(evalExpr("min(10, 4, 7)")).toBe(4);
    expect(evalExpr("max(10, 4, 7)")).toBe(10);
    expect(evalExpr("abs(0 - 8)")).toBe(8);
    expect(evalExpr("floor(7.9)")).toBe(7);
    expect(evalExpr("ceil(7.1)")).toBe(8);
  });

  test("round with optional decimal places", () => {
    expect(evalExpr("round(2.5)")).toBe(3);
    expect(evalExpr("round(99910510.005, 2)")).toBe(99_910_510.01);
  });

  test("rejects an unknown function", () => {
    expect(evalExpr("frobnicate(1)")).toBeUndefined();
  });
});

describe("evaluateNumericExpression — real lease scenarios", () => {
  test("indexed rent capped at +5% per year (Maciej's case)", () => {
    // CPI index of 7% would lift rent above the 5% cap → the cap wins.
    expect(
      evalExpr("min(rent * (1 + index / 100), rent * 1.05)", {
        rent: 10_000,
        index: 7,
      }),
    ).toBe(10_500);
    // A 3% index stays under the cap → the indexed value wins.
    expect(
      evalExpr("min(rent * (1 + index / 100), rent * 1.05)", {
        rent: 10_000,
        index: 3,
      }),
    ).toBe(10_300);
  });
});

describe("evaluateNumericExpression — malformed input", () => {
  test("returns undefined rather than throwing or emitting NaN", () => {
    expect(evalExpr("")).toBeUndefined();
    expect(evalExpr("2 +")).toBeUndefined();
    expect(evalExpr("2 2")).toBeUndefined();
    expect(evalExpr("(1 + 2")).toBeUndefined();
    expect(evalExpr("@@@")).toBeUndefined();
    expect(evalExpr("1 / 0")).toBeUndefined(); // non-finite → undefined
  });
});
