import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  type ConditionValue,
  evaluateCondition,
  type OperandResolver,
} from "./evaluate";
import {
  COMPARE_OPS,
  type Combinator,
  type ConditionNode,
  conditionNodeSchema,
  type Operand,
  PREDICATE_OPS,
  type RefOperand,
} from "./schema";

// A small fixed key space so generated resolvers actually hold values to
// return (otherwise nearly every operand resolves to undefined).
const KEYS = ["a", "b", "c", "status", "priority", "kind"] as const;

const refOperandArb: fc.Arbitrary<RefOperand> = fc.oneof(
  fc
    .constantFrom("a", "b", "c")
    .map((propertyId): RefOperand => ({ type: "property", propertyId })),
  fc
    .constantFrom("status", "priority")
    .map((field): RefOperand => ({ type: "builtin", field })),
  fc.constant<RefOperand>({ type: "kind" }),
  fc
    .constantFrom("a", "b", "c")
    .map((path): RefOperand => ({ type: "path", path })),
);

const literalArb: fc.Arbitrary<Operand> = fc
  .oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.string()))
  .map((value): Operand => ({ type: "literal", value }));

const operandArb: fc.Arbitrary<Operand> = fc.oneof(refOperandArb, literalArb);

const leafArb: fc.Arbitrary<ConditionNode> = fc.oneof(
  fc.tuple(operandArb, fc.constantFrom(...COMPARE_OPS), operandArb).map(
    ([left, op, right]): ConditionNode => ({
      type: "compare",
      left,
      op,
      right,
    }),
  ),
  fc
    .tuple(
      operandArb,
      fc.constantFrom(...PREDICATE_OPS),
      fc.oneof(fc.string(), fc.array(fc.string())),
    )
    .map(
      ([operand, op, value]): ConditionNode => ({
        type: "predicate",
        operand,
        op,
        value,
      }),
    ),
);

const { node: nodeArb } = fc.letrec<{ node: ConditionNode }>((tie) => ({
  node: fc.oneof(
    { weight: 3, arbitrary: leafArb },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom<Combinator>("and", "or"),
          fc.boolean(),
          fc.array(tie("node"), { maxLength: 3 }),
        )
        .map(
          ([combinator, negated, children]): ConditionNode => ({
            type: "group",
            combinator,
            negated,
            children,
          }),
        ),
    },
  ),
}));

const valueArb: fc.Arbitrary<ConditionValue> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.array(fc.string()),
);

const dataArb = fc.dictionary(fc.constantFrom(...KEYS), valueArb);

const makeResolver =
  (data: Record<string, ConditionValue>): OperandResolver =>
  (operand) => {
    if (operand.type === "property") {
      return data[operand.propertyId];
    }
    if (operand.type === "path") {
      return data[operand.path];
    }
    if (operand.type === "kind") {
      return data["kind"];
    }
    if (operand.type === "builtin") {
      return data[operand.field];
    }
    return undefined;
  };

const negate = (child: ConditionNode): ConditionNode => ({
  type: "group",
  combinator: "and",
  negated: true,
  children: [child],
});

describe("evaluator invariants (property-based)", () => {
  test("every generated node is schema-valid and evaluation is total", () => {
    fc.assert(
      fc.property(nodeArb, dataArb, (node, data) => {
        expect(v.is(conditionNodeSchema, node)).toBe(true);
        expect(typeof evaluateCondition(node, makeResolver(data))).toBe(
          "boolean",
        );
      }),
    );
  });

  test("a group combinator equals every/some over its children", () => {
    fc.assert(
      fc.property(
        fc.array(nodeArb, { maxLength: 4 }),
        fc.constantFrom<Combinator>("and", "or"),
        dataArb,
        (children, combinator, data) => {
          const resolve = makeResolver(data);
          const group: ConditionNode = { type: "group", combinator, children };
          const expected =
            combinator === "and"
              ? children.every((c) => evaluateCondition(c, resolve))
              : children.some((c) => evaluateCondition(c, resolve));
          expect(evaluateCondition(group, resolve)).toBe(expected);
        },
      ),
    );
  });

  test("double negation is identity", () => {
    fc.assert(
      fc.property(nodeArb, dataArb, (node, data) => {
        const resolve = makeResolver(data);
        expect(evaluateCondition(negate(negate(node)), resolve)).toBe(
          evaluateCondition(node, resolve),
        );
      }),
    );
  });

  test("neq is the negation of eq for the same operands", () => {
    fc.assert(
      fc.property(operandArb, operandArb, dataArb, (left, right, data) => {
        const resolve = makeResolver(data);
        const eqNode: ConditionNode = {
          type: "compare",
          left,
          op: "eq",
          right,
        };
        const neqNode: ConditionNode = {
          type: "compare",
          left,
          op: "neq",
          right,
        };
        expect(evaluateCondition(eqNode, resolve)).toBe(
          !evaluateCondition(neqNode, resolve),
        );
      }),
    );
  });

  test("not_contains is the negation of contains", () => {
    fc.assert(
      fc.property(
        refOperandArb,
        fc.string(),
        dataArb,
        (operand, value, data) => {
          const resolve = makeResolver(data);
          const contains: ConditionNode = {
            type: "predicate",
            operand,
            op: "contains",
            value,
          };
          const notContains: ConditionNode = {
            type: "predicate",
            operand,
            op: "not_contains",
            value,
          };
          expect(evaluateCondition(contains, resolve)).toBe(
            !evaluateCondition(notContains, resolve),
          );
        },
      ),
    );
  });

  test("is_not_empty is the negation of is_empty", () => {
    fc.assert(
      fc.property(refOperandArb, dataArb, (operand, data) => {
        const resolve = makeResolver(data);
        const empty: ConditionNode = {
          type: "predicate",
          operand,
          op: "is_empty",
        };
        const notEmpty: ConditionNode = {
          type: "predicate",
          operand,
          op: "is_not_empty",
        };
        expect(evaluateCondition(empty, resolve)).toBe(
          !evaluateCondition(notEmpty, resolve),
        );
      }),
    );
  });

  // An absolute oracle for the ordered operators: any value compared to itself
  // must satisfy gte/lte and fail gt/lt, whatever its type. The totality and
  // complement properties above all pass on a uniformly wrong-but-boolean
  // result (e.g. gt/lt always false for dates), so this is what actually pins
  // gt/lt/gte/lte semantics — and what would have caught the ISO-date bug.
  test("ordered comparisons are reflexive for any non-blank literal value", () => {
    fc.assert(
      fc.property(
        // Exclude the empty string: a blank value is the "not comparable"
        // sentinel and is intentionally excluded from ordered comparisons.
        fc.oneof(fc.string({ minLength: 1 }), fc.integer(), fc.boolean()),
        (value) => {
          const resolve = makeResolver({});
          const cmp = (op: "gt" | "lt" | "gte" | "lte"): ConditionNode => ({
            type: "compare",
            left: { type: "literal", value },
            op,
            right: { type: "literal", value },
          });
          expect(evaluateCondition(cmp("gte"), resolve)).toBe(true);
          expect(evaluateCondition(cmp("lte"), resolve)).toBe(true);
          expect(evaluateCondition(cmp("gt"), resolve)).toBe(false);
          expect(evaluateCondition(cmp("lt"), resolve)).toBe(false);
        },
      ),
    );
  });

  // Another absolute oracle: an absent value (resolves to undefined) is not
  // comparable, so no ordered operator may match it against a real literal.
  // The lexicographic fallback would otherwise rank "" before every date.
  test("an absent value never satisfies an ordered comparison", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"gt" | "lt" | "gte" | "lte">("gt", "lt", "gte", "lte"),
        fc.oneof(fc.string({ minLength: 1 }), fc.integer()),
        (op, literal) => {
          const node: ConditionNode = {
            type: "compare",
            left: { type: "property", propertyId: "missing" },
            op,
            right: { type: "literal", value: literal },
          };
          expect(evaluateCondition(node, makeResolver({}))).toBe(false);
        },
      ),
    );
  });
});
