import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { evaluateCondition as evaluateAst } from "@stll/conditions";
import type { ConditionNode, Operand } from "@stll/conditions";
import { propertyConfig } from "@stll/property-testing";

import { serializeCondition } from "./condition-builder.js";
import { evaluateCondition } from "./index.js";
import { resolvePath } from "./path.js";

// The builder edits the AST and the document stores the expression string, so
// the two representations must decide every condition the same way. Structural
// equality is the wrong property (`not (a and b)` re-parses with an extra
// wrapping group, and a single-child group loses its wrapper), so the property
// is the one that matters to a fill: the same verdict on the same data.

type ConditionData = {
  signed: boolean;
  country: string;
  rent: number;
  parties: string[];
  party: { role: string };
};

const PATHS = ["signed", "country", "rent", "parties", "party.role"] as const;

const conditionData = fc.record<ConditionData>({
  signed: fc.boolean(),
  country: fc.constantFrom("PL", "DE", ""),
  rent: fc.integer({ min: 0, max: 5000 }),
  parties: fc.subarray(["buyer", "seller", "guarantor"]),
  party: fc.record({ role: fc.constantFrom("buyer", "guarantor") }),
});

const pathOperand: fc.Arbitrary<Operand> = fc
  .constantFrom(...PATHS)
  .map((path) => ({ type: "path", path }));

const literalOperand: fc.Arbitrary<Operand> = fc
  .oneof(
    fc.constantFrom("PL", "DE", "guarantor", ""),
    fc.integer({ min: 0, max: 5000 }),
    fc.boolean(),
  )
  .map((value) => ({ type: "literal", value }));

const compareNode: fc.Arbitrary<ConditionNode> = fc
  .tuple(
    pathOperand,
    fc.constantFrom(
      "eq" as const,
      "neq" as const,
      "gt" as const,
      "lt" as const,
      "gte" as const,
      "lte" as const,
    ),
    fc.oneof(literalOperand, pathOperand),
  )
  .map(([left, op, right]) => ({ type: "compare", left, op, right }));

const predicateNode: fc.Arbitrary<ConditionNode> = fc.oneof(
  pathOperand.map((operand) => ({
    type: "predicate" as const,
    operand,
    op: "is_truthy" as const,
  })),
  pathOperand.map((operand) => ({
    type: "predicate" as const,
    operand,
    op: "is_empty" as const,
  })),
  pathOperand.map((operand) => ({
    type: "predicate" as const,
    operand,
    op: "is_not_empty" as const,
  })),
  fc
    .tuple(pathOperand, fc.constantFrom("guarantor", "PL", "seller"))
    .map(([operand, value]) => ({
      type: "predicate" as const,
      operand,
      op: "contains" as const,
      value,
    })),
);

const leafNode = fc.oneof(compareNode, predicateNode);

const conditionNode: fc.Arbitrary<ConditionNode> = fc.letrec<{
  node: ConditionNode;
}>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leafNode,
    fc
      .tuple(
        fc.constantFrom("and" as const, "or" as const),
        fc.array(tie("node"), { minLength: 2, maxLength: 3 }),
        fc.boolean(),
      )
      .map(([combinator, children, negated]): ConditionNode =>
        negated
          ? { type: "group", combinator, children, negated }
          : { type: "group", combinator, children },
      ),
  ),
})).node;

describe("condition round-trip", () => {
  test("the serialized expression decides every case the AST does", () => {
    fc.assert(
      fc.property(conditionNode, conditionData, (node, data) => {
        const expression = serializeCondition(node);
        const fromAst = evaluateAst(node, (operand) =>
          operand.type === "path"
            ? // The string evaluator normalizes arrays to strings; mirror it so
              // the two sides compare like for like.
              normalize(resolvePath(operand.path, data))
            : undefined,
        );
        expect(evaluateCondition(expression, data)).toBe(fromAst);
      }),
      propertyConfig(),
    );
  });
});

const normalize = (
  raw: unknown,
): string | number | boolean | string[] | undefined | null => {
  if (raw === null || raw === undefined) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  ) {
    return raw;
  }
  return undefined;
};
