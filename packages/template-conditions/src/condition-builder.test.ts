import { describe, expect, test } from "bun:test";

import { type ConditionNode, serializeCondition } from "./condition-builder.js";
import { evaluateCondition } from "./index.js";

describe("serializeCondition", () => {
  test("a single rule needs no parentheses", () => {
    expect(
      serializeCondition({
        kind: "rule",
        variable: "npf",
        operator: "==",
        value: true,
      }),
    ).toBe("npf == true");
  });

  test("quotes and escapes string values; emits numbers/booleans bare", () => {
    expect(
      serializeCondition({
        kind: "rule",
        variable: "jurisdiction",
        operator: "==",
        value: "CZ",
      }),
    ).toBe('jurisdiction == "CZ"');
    expect(
      serializeCondition({
        kind: "rule",
        variable: "x",
        operator: "==",
        value: 'a"b',
      }),
    ).toBe('x == "a\\"b"');
    expect(
      serializeCondition({
        kind: "rule",
        variable: "term",
        operator: ">=",
        value: 6,
      }),
    ).toBe("term >= 6");
  });

  test("all → and, any → or, with nested groups parenthesised", () => {
    const tree: ConditionNode = {
      kind: "group",
      match: "all",
      children: [
        { kind: "rule", variable: "npf", operator: "==", value: true },
        {
          kind: "group",
          match: "any",
          children: [
            { kind: "rule", variable: "married", operator: "==", value: true },
            {
              kind: "rule",
              variable: "unmarried",
              operator: "==",
              value: true,
            },
          ],
        },
      ],
    };
    expect(serializeCondition(tree)).toBe(
      "npf == true and (married == true or unmarried == true)",
    );
  });

  test("a single-child group drops the joiner and parentheses", () => {
    expect(
      serializeCondition({
        kind: "group",
        match: "all",
        children: [{ kind: "rule", variable: "a", operator: ">", value: 5 }],
      }),
    ).toBe("a > 5");
  });

  test("an empty group serializes to an empty string", () => {
    expect(
      serializeCondition({ kind: "group", match: "all", children: [] }),
    ).toBe("");
  });
});

describe("serializeCondition → evaluateCondition round-trip", () => {
  const tree: ConditionNode = {
    kind: "group",
    match: "all",
    children: [
      { kind: "rule", variable: "npf", operator: "==", value: true },
      {
        kind: "group",
        match: "any",
        children: [
          { kind: "rule", variable: "married", operator: "==", value: true },
          { kind: "rule", variable: "unmarried", operator: "==", value: true },
        ],
      },
    ],
  };
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
});
