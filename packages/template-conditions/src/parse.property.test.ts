import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  COMPARE_OPS,
  type ConditionNode,
  type Operand,
} from "@stll/conditions";
import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { serializeCondition } from "./condition-builder";
import { MAX_CONDITION_NESTING, parseCondition } from "./parse";

const pathOperand: fc.Arbitrary<Operand> = fc
  .constantFrom("country", "party.role", "base-rent", "žadatel.jméno")
  .map((path) => ({ type: "path" as const, path }));
const text = fc.oneof(
  fc.string().filter((value) => !value.includes("\\")),
  fc.constantFrom('"', "'", "\n", "😀"),
);
const operandArb: fc.Arbitrary<Operand> = fc.oneof(
  pathOperand,
  fc
    .oneof(text, fc.integer(), fc.boolean())
    .map((value) => ({ type: "literal" as const, value })),
);
const leaf: fc.Arbitrary<ConditionNode> = fc.oneof(
  fc
    .tuple(operandArb, fc.constantFrom(...COMPARE_OPS), operandArb)
    .map(([left, op, right]) => ({
      type: "compare" as const,
      left,
      op,
      right,
    })),
  fc
    .tuple(
      operandArb,
      fc.constantFrom(
        "is_truthy" as const,
        "is_empty" as const,
        "is_not_empty" as const,
      ),
    )
    .map(([operand, op]) => ({ type: "predicate" as const, operand, op })),
  fc.tuple(pathOperand, text).map(([operand, value]) => ({
    type: "predicate" as const,
    operand,
    op: "contains" as const,
    value,
  })),
);

// Singleton groups collapse during serialization; negation parses as a
// singleton negated AND wrapper. Generate the canonical surface shapes.
// The documented string grammar preserves escaped backslashes rather than
// decoding them, so exact literal round trips use text without backslashes.
const nodeAtDepth = (depth: number): fc.Arbitrary<ConditionNode> => {
  if (depth === 0) {
    return leaf;
  }
  const child = nodeAtDepth(depth - 1);
  return fc.oneof(
    leaf,
    fc
      .tuple(
        fc.constantFrom("and" as const, "or" as const),
        fc.array(child, { minLength: 2, maxLength: 3 }),
      )
      .map(([combinator, children]) => ({
        type: "group" as const,
        combinator,
        children,
      })),
    child.map((node) => ({
      type: "group" as const,
      combinator: "and" as const,
      negated: true,
      children: [node],
    })),
  );
};

test(
  "canonical template trees round-trip through expressions",
  () => {
    fc.assert(
      fc.property(nodeAtDepth(3), (node) => {
        expect(parseCondition(serializeCondition(node))).toEqual(node);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "arbitrary expressions return a condition or null",
  () => {
    const expression = fc.oneof(
      fc.string(),
      fc
        .array(
          fc.constantFrom(
            "not ",
            "(",
            ")",
            "and ",
            "or ",
            '"',
            "'",
            "\\",
            "x ",
          ),
          { maxLength: 200 },
        )
        .map((parts) => parts.join("")),
    );
    fc.assert(
      fc.property(expression, (value) => {
        const parsed = parseCondition(value);
        expect(
          parsed === null ||
            ["compare", "predicate", "group"].includes(parsed.type),
        ).toBe(true);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

const nestedExpression = (depth: number, parentheses: number): string =>
  `${"(".repeat(parentheses)}${"not ".repeat(depth - parentheses)}x${")".repeat(parentheses)}`;

test.each(["parentheses", "negation", "mixed"])(
  "template input boundary accepts canonical %s nesting",
  (shape) => {
    const expressionAt = (depth: number): string => {
      if (shape === "parentheses") {
        return nestedExpression(depth, depth);
      }
      if (shape === "negation") {
        return nestedExpression(depth, 0);
      }
      return nestedExpression(depth, Math.floor(depth / 2));
    };
    expect(parseCondition(expressionAt(MAX_CONDITION_NESTING))).not.toBeNull();
    for (const depth of [MAX_CONDITION_NESTING + 1, 10_000]) {
      expect(parseCondition(expressionAt(depth))).toBeNull();
    }
  },
);

test(
  "template input limits are consistent across nesting shapes",
  () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_CONDITION_NESTING + 1, max: 20_000 }),
        fc.nat(),
        (depth, split) => {
          const expression = nestedExpression(depth, split % (depth + 1));
          expect(parseCondition(expression)).toBeNull();
          expect(
            parseCondition(
              nestedExpression(
                MAX_CONDITION_NESTING,
                split % (MAX_CONDITION_NESTING + 1),
              ),
            ),
          ).not.toBeNull();
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 20 }),
    );
  },
  propertyTestTimeout(5000),
);
