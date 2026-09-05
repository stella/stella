import { describe, expect, test } from "bun:test";

import { runCalculation } from "@stll/calculations";
import { cents, toMajorUnits } from "@stll/money";

import type { CalculationFormatters } from "./calculation-format";
import { formatCalculationResult } from "./calculation-format";

const formatters: CalculationFormatters = {
  number: String,
  money: (amountCents, currency) =>
    `${toMajorUnits({ amountCents, currency })} ${currency}`,
  percent: (ratio) => `${Math.round(ratio * 100)}%`,
};

const labels = { kind: "Sum", unavailable: "—" };

const format = (
  result: Parameters<typeof formatCalculationResult>[0]["result"],
) => formatCalculationResult({ result, formatters, labels });

describe("formatCalculationResult", () => {
  test("a single currency needs no breakdown", () => {
    expect(
      format(
        runCalculation({
          kind: "sum",
          values: [
            { type: "money", amountCents: cents(1000), currency: "CZK" },
          ],
        }),
      ),
    ).toEqual({ summary: "Sum 10 CZK", breakdown: [] });
  });

  test("several currencies stay separate lines, and expand", () => {
    expect(
      format(
        runCalculation({
          kind: "sum",
          values: [
            { type: "money", amountCents: cents(1000), currency: "CZK" },
            { type: "money", amountCents: cents(200), currency: "EUR" },
          ],
        }),
      ),
    ).toEqual({
      summary: "Sum 10 CZK · 2 EUR",
      breakdown: ["10 CZK", "2 EUR"],
    });
  });

  test("a reduction with no answer says so instead of showing a zero", () => {
    expect(
      format(runCalculation({ kind: "average", values: [{ type: "empty" }] })),
    ).toEqual({ summary: "Sum —", breakdown: [] });
  });

  test("a share reads as a percentage", () => {
    expect(
      format(
        runCalculation({
          kind: "percent-filled",
          values: [{ type: "empty" }, { type: "number", value: 1 }],
        }),
      ),
    ).toEqual({ summary: "Sum 50%", breakdown: [] });
  });
});
