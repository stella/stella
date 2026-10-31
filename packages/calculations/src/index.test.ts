import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import type { CalculationValue } from "./index";
import {
  CALCULATION_KINDS,
  isNumericCalculationKind,
  runCalculation,
} from "./index";

const empty: CalculationValue = { type: "empty" };
const num = (value: number): CalculationValue => ({ type: "number", value });
const money = (currency: string, amount: number): CalculationValue => ({
  type: "money",
  amountCents: cents(amount),
  currency,
});
const text = (value: string): CalculationValue => ({ type: "text", value });

describe("counting", () => {
  const values = [num(1), empty, num(1), text("a"), empty];

  test("count is every row, empty or not", () => {
    expect(runCalculation({ kind: "count", values })).toEqual({
      type: "count",
      kind: "count",
      value: 5,
    });
  });

  test("empty and filled partition the rows", () => {
    const emptyCount = runCalculation({ kind: "count-empty", values });
    const filledCount = runCalculation({ kind: "count-filled", values });

    expect(emptyCount).toEqual({
      type: "count",
      kind: "count-empty",
      value: 2,
    });
    expect(filledCount).toEqual({
      type: "count",
      kind: "count-filled",
      value: 3,
    });
  });

  test("unique ignores empties and keys money by currency", () => {
    expect(
      runCalculation({
        kind: "count-unique",
        values: [
          money("CZK", 100),
          money("EUR", 100),
          money("CZK", 100),
          empty,
        ],
      }),
    ).toEqual({ type: "count", kind: "count-unique", value: 2 });
  });

  test("a share of no rows is zero, not a division by zero", () => {
    expect(runCalculation({ kind: "percent-filled", values: [] })).toEqual({
      type: "ratio",
      kind: "percent-filled",
      value: 0,
    });
  });
});

describe("numeric reductions", () => {
  test("sum, average, median, min, max and range read plain numbers", () => {
    const values = [num(1), num(2), num(6), empty];
    const value = (kind: Parameters<typeof runCalculation>[0]["kind"]) => {
      const result = runCalculation({ kind, values });
      return result.type === "number" ? result.value : result;
    };

    expect(value("sum")).toBe(9);
    expect(value("average")).toBe(3);
    expect(value("median")).toBe(2);
    expect(value("min")).toBe(1);
    expect(value("max")).toBe(6);
    expect(value("range")).toBe(5);
  });

  test("a sum with nothing to add is zero", () => {
    expect(runCalculation({ kind: "sum", values: [empty] })).toEqual({
      type: "number",
      kind: "sum",
      value: 0,
    });
  });

  test("an average with nothing to average has no answer", () => {
    expect(runCalculation({ kind: "average", values: [empty] })).toEqual({
      type: "unsupported",
      kind: "average",
      reason: "no-values",
    });
  });

  test("empty and all-null columns have defined results", () => {
    for (const values of [[], [empty, empty]]) {
      expect(runCalculation({ kind: "count", values })).toEqual({
        type: "count",
        kind: "count",
        value: values.length,
      });
      expect(runCalculation({ kind: "count-unique", values })).toEqual({
        type: "count",
        kind: "count-unique",
        value: 0,
      });
      expect(runCalculation({ kind: "sum", values })).toEqual({
        type: "number",
        kind: "sum",
        value: 0,
      });
      for (const kind of [
        "average",
        "median",
        "min",
        "max",
        "range",
      ] as const) {
        expect(runCalculation({ kind, values })).toEqual({
          type: "unsupported",
          kind,
          reason: "no-values",
        });
      }
    }
  });

  test("durations reduce as numbers while dates remain non-numeric text", () => {
    expect(runCalculation({ kind: "sum", values: [num(30), num(90)] })).toEqual(
      {
        type: "number",
        kind: "sum",
        value: 120,
      },
    );
    expect(
      runCalculation({
        kind: "min",
        values: [text("2025-01-01"), text("2026-01-01")],
      }),
    ).toEqual({ type: "unsupported", kind: "min", reason: "non-numeric" });
  });

  test("NaN, infinity and overflowing finite inputs are unsupported", () => {
    for (const values of [
      [num(Number.NaN)],
      [num(Number.POSITIVE_INFINITY)],
      [num(Number.NEGATIVE_INFINITY)],
      [num(Number.MAX_VALUE), num(Number.MAX_VALUE)],
    ]) {
      expect(runCalculation({ kind: "sum", values })).toEqual({
        type: "unsupported",
        kind: "sum",
        reason: "non-numeric",
      });
    }
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [num(1)],
        scopeValues: [num(Number.MAX_VALUE), num(Number.MAX_VALUE)],
      }),
    ).toEqual({
      type: "unsupported",
      kind: "percent-of-total",
      reason: "non-numeric",
    });
  });

  test("text has no numeric reduction", () => {
    expect(
      runCalculation({ kind: "sum", values: [text("a"), num(1)] }),
    ).toEqual({ type: "unsupported", kind: "sum", reason: "non-numeric" });
  });

  test("numbers and money together have no shared unit", () => {
    expect(
      runCalculation({ kind: "sum", values: [num(1), money("CZK", 100)] }),
    ).toEqual({ type: "unsupported", kind: "sum", reason: "mixed-units" });
  });
});

describe("money", () => {
  test("currencies total separately, never into one number", () => {
    const result = runCalculation({
      kind: "sum",
      values: [money("CZK", 1000), money("EUR", 250), money("CZK", 500)],
    });

    expect(result).toEqual({
      type: "money",
      kind: "sum",
      totals: [
        { currency: "CZK", amountCents: cents(1500) },
        { currency: "EUR", amountCents: cents(250) },
      ],
    });
  });

  test("an average lands on a whole minor unit", () => {
    const result = runCalculation({
      kind: "average",
      values: [money("CZK", 100), money("CZK", 101)],
    });

    expect(result).toEqual({
      type: "money",
      kind: "average",
      totals: [{ currency: "CZK", amountCents: cents(101) }],
    });
  });

  test("every currency is reduced independently", () => {
    expect(
      runCalculation({
        kind: "average",
        values: [money("USD", 100), money("EUR", 900), money("USD", 300)],
      }),
    ).toEqual({
      type: "money",
      kind: "average",
      totals: [
        { currency: "EUR", amountCents: cents(900) },
        { currency: "USD", amountCents: cents(200) },
      ],
    });
  });
});

test("counts remain exact for columns larger than typical UI pages", () => {
  const values = Array.from({ length: 100_000 }, (_, index) =>
    index % 10 === 0 ? empty : num(index),
  );
  expect(runCalculation({ kind: "count", values })).toEqual({
    type: "count",
    kind: "count",
    value: 100_000,
  });
  expect(runCalculation({ kind: "count-filled", values })).toEqual({
    type: "count",
    kind: "count-filled",
    value: 90_000,
  });
});

describe("percent of total", () => {
  test("a column's share of the view", () => {
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [num(1), num(1)],
        scopeValues: [num(1), num(1), num(2)],
      }),
    ).toEqual({ type: "ratio", kind: "percent-of-total", value: 0.5 });
  });

  test("a scope holding two currencies has no single whole", () => {
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [money("CZK", 100)],
        scopeValues: [money("CZK", 100), money("EUR", 100)],
      }),
    ).toEqual({
      type: "unsupported",
      kind: "percent-of-total",
      reason: "mixed-units",
    });
  });

  test("a share of a whole nobody named is unsupported, not 100%", () => {
    expect(
      runCalculation({ kind: "percent-of-total", values: [num(1), num(2)] }),
    ).toEqual({
      type: "unsupported",
      kind: "percent-of-total",
      reason: "no-scope",
    });
  });

  test("one currency is not a share of another", () => {
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [money("EUR", 100)],
        scopeValues: [money("CZK", 100)],
      }),
    ).toEqual({
      type: "unsupported",
      kind: "percent-of-total",
      reason: "mixed-units",
    });
  });

  test("a plain number is not a share of an amount of money", () => {
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [num(5)],
        scopeValues: [money("EUR", 100)],
      }),
    ).toEqual({
      type: "unsupported",
      kind: "percent-of-total",
      reason: "mixed-units",
    });
  });

  test("an empty column is nought percent of a whole in any unit", () => {
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [empty],
        scopeValues: [money("EUR", 100)],
      }),
    ).toEqual({ type: "ratio", kind: "percent-of-total", value: 0 });
  });

  test("a whole of zero has no share", () => {
    expect(
      runCalculation({
        kind: "percent-of-total",
        values: [num(0)],
        scopeValues: [num(0)],
      }),
    ).toEqual({
      type: "unsupported",
      kind: "percent-of-total",
      reason: "no-values",
    });
  });
});

const valueArb: fc.Arbitrary<CalculationValue> = fc.oneof(
  fc.constant(empty),
  fc.integer({ min: -1000, max: 1000 }).map(num),
  fc
    .tuple(
      fc.constantFrom("CZK", "EUR"),
      fc.integer({ min: -100_000, max: 100_000 }),
    )
    .map(([currency, amount]) => money(currency, amount)),
  fc.string({ maxLength: 4 }).map(text),
);

const numberArb: fc.Arbitrary<CalculationValue> = fc.oneof(
  fc.constant(empty),
  fc.integer({ min: -1000, max: 1000 }).map(num),
);

describe("invariants", () => {
  test("a reduction reads exactly the rows it is given: order never changes the answer", () => {
    assertProperty(
      "a reduction reads exactly the rows it is given: order never changes the answer",
      fc.property(
        fc.array(valueArb, { maxLength: 20 }),
        fc.constantFrom(...CALCULATION_KINDS),
        fc.nat(),
        (values, kind, rotation) => {
          const offset = values.length === 0 ? 0 : rotation % values.length;
          const rotated = [...values.slice(offset), ...values.slice(0, offset)];

          expect(
            runCalculation({ kind, values: rotated, scopeValues: values }),
          ).toEqual(runCalculation({ kind, values, scopeValues: values }));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("counting a column and counting its halves agree", () => {
    assertProperty(
      "counting a column and counting its halves agree",
      fc.property(
        fc.array(valueArb, { maxLength: 20 }),
        fc.array(valueArb, { maxLength: 20 }),
        (left, right) => {
          const whole = runCalculation({
            kind: "count-filled",
            values: [...left, ...right],
          });
          const parts =
            countOf(runCalculation({ kind: "count-filled", values: left })) +
            countOf(runCalculation({ kind: "count-filled", values: right }));

          expect(countOf(whole)).toBe(parts);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("a sum over the columns of a board equals the sum over the board", () => {
    assertProperty(
      "a sum over the columns of a board equals the sum over the board",
      fc.property(
        fc.array(fc.array(numberArb, { maxLength: 10 }), { maxLength: 5 }),
        (columns) => {
          const board = columns.flat();
          const columnTotals = columns
            .map((column) => runCalculation({ kind: "sum", values: column }))
            .reduce(
              (total, result) =>
                total + (result.type === "number" ? result.value : 0),
              0,
            );
          const boardTotal = runCalculation({ kind: "sum", values: board });

          expect(boardTotal.type === "number" ? boardTotal.value : null).toBe(
            columnTotals,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("every column's share of the board adds up to the whole", () => {
    assertProperty(
      "every column's share of the board adds up to the whole",
      fc.property(
        fc.array(
          fc.array(fc.integer({ min: 1, max: 100 }).map(num), {
            minLength: 1,
            maxLength: 10,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (columns) => {
          const board = columns.flat();
          const shares = columns.map((column) => {
            const result = runCalculation({
              kind: "percent-of-total",
              values: column,
              scopeValues: board,
            });
            return result.type === "ratio" ? result.value : 0;
          });

          expect(shares.reduce((total, share) => total + share, 0)).toBeCloseTo(
            1,
            10,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("only numeric kinds can come back unsupported", () => {
    assertProperty(
      "only numeric kinds can come back unsupported",
      fc.property(
        fc.array(valueArb, { maxLength: 10 }),
        fc.constantFrom(...CALCULATION_KINDS),
        (values, kind) => {
          const result = runCalculation({ kind, values, scopeValues: values });
          if (result.type === "unsupported") {
            expect(isNumericCalculationKind(kind)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test("sum and count agree with finite filled values, and extrema bound average", () => {
    assertProperty(
      "sum and count agree with finite filled values, and extrema bound average",
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (raw) => {
          const values = raw.map(num);
          const sum = runCalculation({ kind: "sum", values });
          const average = runCalculation({ kind: "average", values });
          const min = runCalculation({ kind: "min", values });
          const max = runCalculation({ kind: "max", values });
          const count = runCalculation({ kind: "count-filled", values });

          expect(sum.type).toBe("number");
          expect(average.type).toBe("number");
          expect(min.type).toBe("number");
          expect(max.type).toBe("number");
          expect(count.type).toBe("count");
          if (
            sum.type === "number" &&
            average.type === "number" &&
            min.type === "number" &&
            max.type === "number" &&
            count.type === "count"
          ) {
            expect(average.value * count.value).toBeCloseTo(sum.value, 8);
            expect(min.value).toBeLessThanOrEqual(average.value);
            expect(average.value).toBeLessThanOrEqual(max.value);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

const countOf = (result: ReturnType<typeof runCalculation>): number =>
  result.type === "count" ? result.value : Number.NaN;
