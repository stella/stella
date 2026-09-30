import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  BUILTIN_FIELDS,
  COMBINATORS,
  COMPARE_OPS,
  type ConditionNode,
  conditionNodeSchema,
  type Operand,
  PREDICATE_OPS,
} from "@stll/conditions";
import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";
import { MAX_CONDITION_NESTING } from "@stll/template-conditions";

import { parseStoredCondition } from "./parse-stored";

const nonemptyText = fc.string({ minLength: 1, maxLength: 1000 });
const operandArb: fc.Arbitrary<Operand> = fc.oneof(
  nonemptyText.map((propertyId) => ({ type: "property", propertyId })),
  nonemptyText.map((path) => ({ type: "path", path })),
  fc
    .constantFrom(...BUILTIN_FIELDS)
    .map((field) => ({ type: "builtin", field })),
  fc.constant({ type: "kind" as const }),
  fc
    .oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.string(), { maxLength: 5 }),
    )
    .map((value) => ({ type: "literal", value })),
);
const leaf: fc.Arbitrary<ConditionNode> = fc.oneof(
  fc
    .tuple(operandArb, fc.constantFrom(...COMPARE_OPS), operandArb)
    .map(([left, op, right]) => ({ type: "compare", left, op, right })),
  fc
    .tuple(
      operandArb,
      fc.constantFrom(...PREDICATE_OPS),
      fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 5 })),
    )
    .map(([operand, op, value]) => ({ type: "predicate", operand, op, value })),
);
const nodeAtDepth = (depth: number): fc.Arbitrary<ConditionNode> => {
  if (depth === 0) {
    return leaf;
  }
  return fc.oneof(
    leaf,
    fc
      .tuple(
        fc.constantFrom(...COMBINATORS),
        fc.array(nodeAtDepth(depth - 1), { maxLength: 3 }),
        fc.boolean(),
      )
      .map(([combinator, children, negated]) => ({
        type: "group",
        combinator,
        children,
        negated,
      })),
  );
};
const stored = fc.oneof(
  fc.jsonValue(),
  fc.constant(undefined),
  nodeAtDepth(3),
  nonemptyText.map((value) => ({
    version: 1,
    type: "string",
    operator: "eq",
    value,
  })),
  fc.array(nonemptyText, { minLength: 1, maxLength: 5 }).map((value) => ({
    version: 1,
    type: "string-array",
    operator: "contains-every",
    value,
  })),
);

test(
  "accepted stored forms have a stable canonical JSON representation",
  () => {
    fc.assert(
      fc.property(stored, nonemptyText, (value, propertyId) => {
        const parsed = parseStoredCondition(value, propertyId);
        if (parsed.status === "invalid") {
          return;
        }
        const serialized = JSON.stringify(parsed.condition);
        const reparsed = parseStoredCondition(
          JSON.parse(serialized),
          propertyId,
        );
        expect(reparsed).toEqual(parsed);
        if (parsed.condition !== null) {
          expect(v.is(conditionNodeSchema, parsed.condition)).toBe(true);
        }
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "canonical stored trees retain every field",
  () => {
    fc.assert(
      fc.property(nodeAtDepth(3), nonemptyText, (condition, propertyId) => {
        expect(parseStoredCondition(condition, propertyId)).toEqual({
          status: "valid",
          condition,
        });
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "legacy stored forms preserve their operands and payloads",
  () => {
    fc.assert(
      fc.property(
        nonemptyText,
        nonemptyText,
        fc.array(nonemptyText, { minLength: 1, maxLength: 5 }),
        (propertyId, value, values) => {
          expect(
            parseStoredCondition(
              { version: 1, type: "string", operator: "eq", value },
              propertyId,
            ),
          ).toEqual({
            status: "valid",
            condition: {
              type: "compare",
              left: { type: "property", propertyId },
              op: "eq",
              right: { type: "literal", value },
            },
          });
          expect(
            parseStoredCondition(
              {
                version: 1,
                type: "string-array",
                operator: "contains-every",
                value: values,
              },
              propertyId,
            ),
          ).toEqual({
            status: "valid",
            condition: {
              type: "predicate",
              operand: { type: "property", propertyId },
              op: "contains_all",
              value: values,
            },
          });
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

const nestedStored = (depth: number): ConditionNode => {
  let condition: ConditionNode = {
    type: "predicate",
    operand: { type: "kind" },
    op: "is_truthy",
  };
  for (let level = 0; level < depth; level++) {
    condition = { type: "group", combinator: "and", children: [condition] };
  }
  return condition;
};

test(
  "stored input limits preserve the boundary representation",
  () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_CONDITION_NESTING + 1, max: 20_000 }),
        (depth) => {
          for (const nesting of [MAX_CONDITION_NESTING + 1, 10_000, depth]) {
            expect(
              parseStoredCondition(nestedStored(nesting), "source"),
            ).toEqual({
              status: "invalid",
            });
          }
          const condition = nestedStored(MAX_CONDITION_NESTING);
          expect(parseStoredCondition(condition, "source")).toEqual({
            status: "valid",
            condition,
          });
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 20 }),
    );
  },
  propertyTestTimeout(5000),
);

test("stored graph inputs have a finite validation result", () => {
  const cycle: ConditionNode = {
    type: "group",
    combinator: "and",
    children: [],
  };
  cycle.children.push(cycle);
  expect(parseStoredCondition(cycle, "source")).toEqual({ status: "invalid" });
});
