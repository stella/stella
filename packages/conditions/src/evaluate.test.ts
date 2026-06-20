import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  type ConditionValue,
  evaluateCondition,
  pruneIncomplete,
} from "./evaluate";
import {
  type CompareOp,
  type ConditionNode,
  conditionNodeSchema,
  emptyCondition,
  type LiteralValue,
  type RefOperand,
} from "./schema";

/** A simple record-backed resolver for `property`/`path` operands. */
const resolverFor =
  (data: Record<string, ConditionValue>) =>
  (operand: RefOperand): ConditionValue => {
    if (operand.type === "property") {
      return data[operand.propertyId];
    }
    if (operand.type === "path") {
      return data[operand.path];
    }
    if (operand.type === "kind") {
      return data["kind"];
    }
    return data[operand.field];
  };

const compare = (
  left: RefOperand,
  op: CompareOp,
  literal: LiteralValue,
): ConditionNode => ({
  type: "compare",
  left,
  op,
  right: { type: "literal", value: literal },
});

describe("compare operators", () => {
  test("eq normalizes nullish and number/string across types", () => {
    const node = compare(
      { type: "property", propertyId: "type" },
      "eq",
      "Lease",
    );
    expect(evaluateCondition(node, resolverFor({ type: "Lease" }))).toBe(true);
    expect(evaluateCondition(node, resolverFor({ type: "NDA" }))).toBe(false);
    expect(evaluateCondition(node, resolverFor({}))).toBe(false);

    const numNode = compare({ type: "path", path: "amount" }, "eq", 1000);
    expect(evaluateCondition(numNode, resolverFor({ amount: "1000" }))).toBe(
      true,
    );
  });

  test("numeric comparisons coerce strings and fail on non-numbers", () => {
    const gt = compare({ type: "path", path: "amount" }, "gt", 1000);
    expect(evaluateCondition(gt, resolverFor({ amount: 1500 }))).toBe(true);
    expect(evaluateCondition(gt, resolverFor({ amount: "500" }))).toBe(false);
    expect(evaluateCondition(gt, resolverFor({ amount: "n/a" }))).toBe(false);
  });

  test("non-numeric literals compare lexicographically (ISO dates order chronologically)", () => {
    const after = compare(
      { type: "property", propertyId: "due" },
      "gt",
      "2026-01-01",
    );
    expect(evaluateCondition(after, resolverFor({ due: "2026-06-01" }))).toBe(
      true,
    );
    expect(evaluateCondition(after, resolverFor({ due: "2025-12-31" }))).toBe(
      false,
    );

    const onOrBefore = compare(
      { type: "property", propertyId: "due" },
      "lte",
      "2026-06-18",
    );
    expect(
      evaluateCondition(onOrBefore, resolverFor({ due: "2026-06-18" })),
    ).toBe(true);
    expect(
      evaluateCondition(onOrBefore, resolverFor({ due: "2026-07-01" })),
    ).toBe(false);
  });

  test("pruneIncomplete drops incomplete leaves and empty groups", () => {
    const real = compare({ type: "property", propertyId: "x" }, "eq", "a");
    const incompleteGt = compare(
      { type: "property", propertyId: "x" },
      "gt",
      "",
    );
    const incompleteContains: ConditionNode = {
      type: "predicate",
      operand: { type: "property", propertyId: "x" },
      op: "contains",
      value: "",
    };
    const eqEmpty = compare({ type: "property", propertyId: "x" }, "eq", "");
    const isEmpty: ConditionNode = {
      type: "predicate",
      operand: { type: "property", propertyId: "x" },
      op: "is_empty",
    };

    // Incomplete leaves prune away; complete ones (incl. `eq ""`, `is_empty`) stay.
    expect(pruneIncomplete(incompleteGt)).toBeNull();
    expect(pruneIncomplete(incompleteContains)).toBeNull();
    expect(pruneIncomplete(real)).toEqual(real);
    expect(pruneIncomplete(eqEmpty)).toEqual(eqEmpty);
    expect(pruneIncomplete(isEmpty)).toEqual(isEmpty);

    // A group keeps real children and drops incomplete ones...
    expect(
      pruneIncomplete({
        type: "group",
        combinator: "or",
        children: [incompleteGt, real],
      }),
    ).toEqual({ type: "group", combinator: "or", children: [real] });

    // ...and a group of only incomplete leaves prunes to null.
    expect(
      pruneIncomplete({
        type: "group",
        combinator: "and",
        children: [incompleteGt, incompleteContains],
      }),
    ).toBeNull();
  });
});

describe("predicate operators", () => {
  const operand: RefOperand = { type: "property", propertyId: "tags" };

  test("is_empty across scalar, array, and absent", () => {
    const node: ConditionNode = { type: "predicate", operand, op: "is_empty" };
    expect(evaluateCondition(node, resolverFor({}))).toBe(true);
    expect(evaluateCondition(node, resolverFor({ tags: "" }))).toBe(true);
    expect(evaluateCondition(node, resolverFor({ tags: [] }))).toBe(true);
    expect(evaluateCondition(node, resolverFor({ tags: ["a"] }))).toBe(false);
  });

  test("contains_all mirrors the legacy contains-every multi-select gate", () => {
    const node: ConditionNode = {
      type: "predicate",
      operand,
      op: "contains_all",
      value: ["a", "b"],
    };
    expect(
      evaluateCondition(node, resolverFor({ tags: ["a", "b", "c"] })),
    ).toBe(true);
    expect(evaluateCondition(node, resolverFor({ tags: ["a"] }))).toBe(false);
  });

  test("contains is case-insensitive substring (scalar) or membership (array)", () => {
    const scalar: ConditionNode = {
      type: "predicate",
      operand: { type: "property", propertyId: "title" },
      op: "contains",
      value: "lease",
    };
    expect(
      evaluateCondition(scalar, resolverFor({ title: "Master LEASE v2" })),
    ).toBe(true);
  });

  test("in tests membership of the resolved value in the payload set", () => {
    const node: ConditionNode = {
      type: "predicate",
      operand: { type: "builtin", field: "status" },
      op: "in",
      value: ["open", "review"],
    };
    expect(evaluateCondition(node, resolverFor({ status: "review" }))).toBe(
      true,
    );
    expect(evaluateCondition(node, resolverFor({ status: "done" }))).toBe(
      false,
    );
  });
});

describe("groups", () => {
  test("empty AND root matches everything; empty OR matches nothing", () => {
    expect(evaluateCondition(emptyCondition(), resolverFor({}))).toBe(true);
    expect(
      evaluateCondition(
        { type: "group", combinator: "or", children: [] },
        resolverFor({}),
      ),
    ).toBe(false);
  });

  test("and/or combinators and negation compose", () => {
    const isLease = compare(
      { type: "property", propertyId: "type" },
      "eq",
      "Lease",
    );
    const bigAmount = compare({ type: "path", path: "amount" }, "gt", 1000);

    const and: ConditionNode = {
      type: "group",
      combinator: "and",
      children: [isLease, bigAmount],
    };
    expect(
      evaluateCondition(and, resolverFor({ type: "Lease", amount: 2000 })),
    ).toBe(true);
    expect(
      evaluateCondition(and, resolverFor({ type: "Lease", amount: 10 })),
    ).toBe(false);

    const negated: ConditionNode = {
      type: "group",
      combinator: "and",
      negated: true,
      children: [isLease],
    };
    expect(evaluateCondition(negated, resolverFor({ type: "NDA" }))).toBe(true);
  });
});

describe("schema", () => {
  test("validates a nested group round-trip", () => {
    const node: ConditionNode = {
      type: "group",
      combinator: "or",
      children: [
        compare({ type: "property", propertyId: "type" }, "eq", "Lease"),
        {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "predicate",
              operand: { type: "property", propertyId: "tags" },
              op: "contains_all",
              value: ["x"],
            },
          ],
        },
      ],
    };
    expect(v.parse(conditionNodeSchema, node)).toEqual(node);
  });

  test("rejects unknown operators and extra keys", () => {
    expect(() =>
      v.parse(conditionNodeSchema, {
        type: "compare",
        left: { type: "kind" },
        op: "bogus",
        right: { type: "literal", value: "x" },
      }),
    ).toThrow();
  });
});
