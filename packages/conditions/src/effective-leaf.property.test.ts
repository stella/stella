import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { isEffectiveLeaf } from "./effective-leaf";
import { type FoldHandlers, foldCondition } from "./fold";
import {
  COMPARE_OPS,
  type CompareNode,
  type Combinator,
  type ConditionNode,
  type Operand,
  PREDICATE_OPS,
  type PredicateNode,
} from "./schema";

/**
 * Differential check between `isEffectiveLeaf` and `foldCondition`: whatever
 * the fold's own drop rule decides for a tree whose `leaf` handler defers to
 * `isEffectiveLeaf` must equal calling `isEffectiveLeaf` on each leaf
 * directly. Both sides own a different half of "which leaves survive"
 * (fold.ts owns the group/empty-group mechanics, this predicate owns the
 * leaf-level decision); this is the guarantee that composing them behaves.
 */

const operandArb: fc.Arbitrary<Operand> = fc.oneof(
  fc
    .constantFrom("a", "b")
    .map((propertyId): Operand => ({ type: "property", propertyId })),
  fc
    .constantFrom("status", "priority")
    .map((field): Operand => ({ type: "builtin", field })),
  fc.constant<Operand>({ type: "kind" }),
  fc.constantFrom("a", "b").map((path): Operand => ({ type: "path", path })),
  fc.constant<Operand>({ type: "formula", expr: "x" }),
  fc
    .oneof(
      fc.constant(""),
      fc.string(),
      fc.array(fc.string(), { maxLength: 2 }),
    )
    .map((value): Operand => ({ type: "literal", value })),
);

const compareLeafArb: fc.Arbitrary<CompareNode> = fc
  .tuple(operandArb, fc.constantFrom(...COMPARE_OPS), operandArb)
  .map(([left, op, right]) => ({ type: "compare" as const, left, op, right }));

const predicateValueArb = fc.oneof(
  fc.constant(undefined),
  fc.string(),
  fc.array(fc.string(), { maxLength: 2 }),
);

const predicateLeafArb: fc.Arbitrary<PredicateNode> = fc
  .tuple(operandArb, fc.constantFrom(...PREDICATE_OPS), predicateValueArb)
  .map(([operand, op, value]): PredicateNode => {
    const node: PredicateNode = { type: "predicate", operand, op };
    if (value !== undefined) {
      node.value = value;
    }
    return node;
  });

const leafArb: fc.Arbitrary<ConditionNode> = fc.oneof(
  compareLeafArb,
  predicateLeafArb,
);

const { node: nodeArb } = fc.letrec<{ node: ConditionNode }>((tie) => ({
  node: fc.oneof(
    { weight: 3, arbitrary: leafArb },
    {
      weight: 1,
      arbitrary: fc
        .record({
          combinator: fc.constantFrom<Combinator>("and", "or"),
          negated: fc.boolean(),
          children: fc.array(tie("node"), { minLength: 1, maxLength: 3 }),
        })
        .map(({ combinator, negated, children }): ConditionNode => ({
          type: "group",
          combinator,
          negated,
          children,
        })),
    },
  ),
}));

const isLeafNode = (node: ConditionNode): node is CompareNode | PredicateNode =>
  node.type === "compare" || node.type === "predicate";

const collectLeaves = (
  node: ConditionNode,
): readonly (CompareNode | PredicateNode)[] =>
  isLeafNode(node) ? [node] : node.children.flatMap(collectLeaves);

describe("isEffectiveLeaf + foldCondition (property-based)", () => {
  test("leaves surviving the fold equal the leaves isEffectiveLeaf accepts, and an emptied group never reaches group", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const expected = new Set(
          collectLeaves(node).filter((leaf) => isEffectiveLeaf(leaf)),
        );

        const handlers: FoldHandlers<ConditionNode> = {
          leaf: (leaf) => (isEffectiveLeaf(leaf) ? leaf : null),
          group: (groupNode, children) => {
            // fold.ts's own contract: `group` is never called with an empty
            // `children` array — an emptied group is dropped before it runs.
            expect(children.length).toBeGreaterThan(0);
            return { ...groupNode, children: [...children] };
          },
        };

        const folded = foldCondition(node, handlers);
        const survivors = new Set(folded === null ? [] : collectLeaves(folded));

        expect(survivors).toEqual(expected);
      }),
      propertyConfig(),
    );
  });
});
