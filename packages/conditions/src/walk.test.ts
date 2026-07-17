import { describe, expect, test } from "bun:test";

import type { ConditionNode } from "./schema";
import { conditionHasFormula, conditionIncludesKind } from "./walk";

describe("conditionHasFormula", () => {
  test("false for a tree of literal/path/property operands", () => {
    const node: ConditionNode = {
      type: "group",
      combinator: "and",
      children: [
        {
          type: "compare",
          left: { type: "path", path: "rent" },
          op: "lt",
          right: { type: "literal", value: 100_000 },
        },
        {
          type: "predicate",
          operand: { type: "property", propertyId: "tags" },
          op: "contains",
          value: "x",
        },
      ],
    };
    expect(conditionHasFormula(node)).toBe(false);
  });

  test("true when a formula operand sits in a nested group", () => {
    const node: ConditionNode = {
      type: "group",
      combinator: "or",
      children: [
        {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "compare",
              left: { type: "formula", expr: "rent * 12" },
              op: "gt",
              right: { type: "literal", value: 1000 },
            },
          ],
        },
      ],
    };
    expect(conditionHasFormula(node)).toBe(true);
  });
});

describe("conditionIncludesKind", () => {
  test("finds a kind inside a nested condition group", () => {
    const filters: ConditionNode[] = [
      {
        type: "group",
        combinator: "and",
        children: [
          {
            type: "predicate",
            operand: { type: "kind" },
            op: "in",
            value: ["task"],
          },
        ],
      },
    ];

    expect(conditionIncludesKind(filters, "task")).toBe(true);
    expect(conditionIncludesKind(filters, "document")).toBe(false);
  });
});
