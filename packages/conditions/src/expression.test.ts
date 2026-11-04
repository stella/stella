import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  evaluateExpression,
  EXPRESSION_MAX_DEPTH,
  expressionPropertyIds,
  expressionSchema,
} from "./expression";
import type { Expression, FormulaContext, FormulaValue } from "./expression";

const czk = (amountCents: number): FormulaValue => ({
  type: "money",
  amountCents,
  currency: "CZK",
});

const bids: Record<string, Record<string, FormulaValue>> = {
  a: {
    price: czk(10_000_000),
    deadline: { type: "date", value: "2026-11-30" },
  },
  b: { price: czk(8_000_000), deadline: { type: "date", value: "2026-12-15" } },
  c: { price: czk(8_000_000), deadline: { type: "empty" } },
  d: { price: { type: "empty" }, deadline: { type: "empty" } },
};

const contextFor = (row: string): FormulaContext => ({
  field: (propertyId) => bids[row]?.[propertyId] ?? { type: "empty" },
  column: (propertyId) =>
    Object.values(bids).map(
      (values) => values[propertyId] ?? { type: "empty" },
    ),
  resolveCondition: (operand) =>
    operand.type === "property" ? "Yes" : undefined,
  today: "2026-11-04",
});

const price: Expression = { type: "field", propertyId: "price" };

describe("evaluateExpression", () => {
  test("ranks bids by price with shared ranks for ties", () => {
    const rank: Expression = {
      type: "aggregate",
      fn: "rank_asc",
      propertyId: "price",
    };
    expect(evaluateExpression(rank, contextFor("a"))).toEqual({
      type: "number",
      value: 3,
    });
    expect(evaluateExpression(rank, contextFor("b"))).toEqual({
      type: "number",
      value: 1,
    });
    expect(evaluateExpression(rank, contextFor("c"))).toEqual({
      type: "number",
      value: 1,
    });
    expect(evaluateExpression(rank, contextFor("d"))).toEqual({
      type: "empty",
    });
  });

  test("relates a bid to the lowest one, as a ratio of one currency", () => {
    const ratio: Expression = {
      type: "round",
      digits: 2,
      arg: {
        type: "arithmetic",
        op: "div",
        left: price,
        right: { type: "aggregate", fn: "min", propertyId: "price" },
      },
    };
    expect(evaluateExpression(ratio, contextFor("a"))).toEqual({
      type: "number",
      value: 1.25,
    });
  });

  test("sums money exactly and refuses mixed currencies", () => {
    expect(
      evaluateExpression(
        { type: "aggregate", fn: "sum", propertyId: "price" },
        contextFor("a"),
      ),
    ).toEqual(czk(26_000_000));
    expect(
      evaluateExpression(
        {
          type: "arithmetic",
          op: "add",
          left: price,
          right: { type: "money", amountCents: 1, currency: "EUR" },
        },
        contextFor("a"),
      ),
    ).toEqual({ type: "error", code: "mixed_currencies" });
  });

  test("an empty input makes an empty result, division by zero an error", () => {
    expect(
      evaluateExpression(
        {
          type: "arithmetic",
          op: "mul",
          left: price,
          right: { type: "number", value: 1.21 },
        },
        contextFor("d"),
      ),
    ).toEqual({ type: "empty" });
    expect(
      evaluateExpression(
        {
          type: "arithmetic",
          op: "div",
          left: { type: "number", value: 1 },
          right: { type: "number", value: 0 },
        },
        contextFor("a"),
      ),
    ).toEqual({ type: "error", code: "division_by_zero" });
  });

  test("dates count calendar days against the given today", () => {
    const remaining: Expression = {
      type: "days_between",
      from: { type: "today" },
      to: { type: "field", propertyId: "deadline" },
    };
    expect(evaluateExpression(remaining, contextFor("a"))).toEqual({
      type: "number",
      value: 26,
    });
    expect(
      evaluateExpression(
        {
          type: "add_days",
          date: { type: "date", value: "2028-02-28" },
          days: { type: "number", value: 1 },
        },
        contextFor("a"),
      ),
    ).toEqual({ type: "date", value: "2028-02-29" });
    expect(
      evaluateExpression(
        { type: "date", value: "2026-02-30" },
        contextFor("a"),
      ),
    ).toEqual({ type: "error", code: "invalid_date" });
  });

  test("a conditional reads a condition node as view filters do", () => {
    const verdict: Expression = {
      type: "if",
      when: {
        type: "logic",
        op: "and",
        args: [
          {
            type: "compare",
            op: "lte",
            left: price,
            right: { type: "money", amountCents: 9_000_000, currency: "CZK" },
          },
          {
            type: "condition",
            node: {
              type: "compare",
              left: { type: "property", propertyId: "qualified" },
              op: "eq",
              right: { type: "literal", value: "Yes" },
            },
          },
        ],
      },
      ifTrue: { type: "text", value: "Admissible" },
      ifFalse: { type: "text", value: "Review" },
    };
    expect(evaluateExpression(verdict, contextFor("b"))).toEqual({
      type: "text",
      value: "Admissible",
    });
    expect(evaluateExpression(verdict, contextFor("a"))).toEqual({
      type: "text",
      value: "Review",
    });
  });
});

describe("expressionSchema", () => {
  test("lists the columns a formula reads", () => {
    expect(
      expressionPropertyIds({
        type: "arithmetic",
        op: "div",
        left: price,
        right: { type: "aggregate", fn: "min", propertyId: "other" },
      }),
    ).toEqual(new Set(["price", "other"]));
  });

  test("refuses a formula nested past the limit", () => {
    let deep: Expression = { type: "number", value: 1 };
    for (let level = 0; level < EXPRESSION_MAX_DEPTH; level += 1) {
      deep = { type: "unary", op: "neg", arg: deep };
    }
    expect(v.is(expressionSchema, deep)).toBe(false);
    expect(
      v.is(expressionSchema, { type: "unary", op: "abs", arg: price }),
    ).toBe(true);
  });
});
