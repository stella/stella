import { describe, expect, test } from "bun:test";

import type { CompareOp, ConditionNode, LiteralValue } from "@stll/conditions";

import { serializeCondition } from "./condition-builder.js";
import { evaluateCondition } from "./index.js";

const compare = (
  path: string,
  op: CompareOp,
  value: LiteralValue,
): ConditionNode => ({
  type: "compare",
  left: { type: "path", path },
  op,
  right: { type: "literal", value },
});

const contains = (path: string, value: string): ConditionNode => ({
  type: "predicate",
  operand: { type: "path", path },
  op: "contains",
  value,
});

const and = (...children: ConditionNode[]): ConditionNode => ({
  type: "group",
  combinator: "and",
  children,
});

const or = (...children: ConditionNode[]): ConditionNode => ({
  type: "group",
  combinator: "or",
  children,
});

describe("serializeCondition", () => {
  test("a single rule needs no parentheses", () => {
    expect(serializeCondition(compare("npf", "eq", true))).toBe("npf == true");
  });

  test("quotes and escapes string values; emits numbers/booleans bare", () => {
    expect(serializeCondition(compare("jurisdiction", "eq", "CZ"))).toBe(
      'jurisdiction == "CZ"',
    );
    expect(serializeCondition(compare("x", "eq", 'a"b'))).toBe('x == "a\\"b"');
    expect(serializeCondition(compare("term", "gte", 6))).toBe("term >= 6");
  });

  test("and → and, or → or, with nested groups parenthesised", () => {
    const tree = and(
      compare("npf", "eq", true),
      or(compare("married", "eq", true), compare("unmarried", "eq", true)),
    );
    expect(serializeCondition(tree)).toBe(
      "npf == true and (married == true or unmarried == true)",
    );
  });

  test("a single-child group drops the joiner and parentheses", () => {
    expect(serializeCondition(and(compare("a", "gt", 5)))).toBe("a > 5");
  });

  test("an empty group serializes to an empty string", () => {
    expect(serializeCondition(and())).toBe("");
  });

  test("contains emits a quoted value like the other operators", () => {
    expect(serializeCondition(contains("parties", "guarantor"))).toBe(
      'parties contains "guarantor"',
    );
  });
});

describe("serializeCondition → evaluateCondition round-trip", () => {
  const tree = and(
    compare("npf", "eq", true),
    or(compare("married", "eq", true), compare("unmarried", "eq", true)),
  );
  const expr = serializeCondition(tree);

  test("the built expression evaluates as the structure implies", () => {
    expect(
      evaluateCondition(expr, { npf: true, married: false, unmarried: true }),
    ).toBe(true);
    expect(
      evaluateCondition(expr, { npf: true, married: false, unmarried: false }),
    ).toBe(false);
    expect(
      evaluateCondition(expr, { npf: false, married: true, unmarried: true }),
    ).toBe(false);
  });

  test("a contains rule round-trips through the evaluator", () => {
    const containsExpr = serializeCondition(contains("parties", "guarantor"));
    expect(
      evaluateCondition(containsExpr, { parties: ["buyer", "guarantor"] }),
    ).toBe(true);
    expect(
      evaluateCondition(containsExpr, { parties: ["buyer", "seller"] }),
    ).toBe(false);
  });
});
