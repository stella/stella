import { describe, expect, test } from "bun:test";

import { type FoldHandlers, foldCondition, foldConditions } from "./fold";
import type { ConditionNode } from "./schema";

const kindPredicate = (value: string): ConditionNode => ({
  type: "predicate",
  operand: { type: "kind" },
  op: "in",
  value: [value],
});

/** `leaf` keeps every "kind in [x]" predicate and drops everything else. */
const keepKindLeaf: FoldHandlers<string>["leaf"] = (node) => {
  if (
    node.type === "predicate" &&
    node.operand.type === "kind" &&
    node.op === "in" &&
    Array.isArray(node.value)
  ) {
    return node.value.join(",");
  }
  return null;
};

/** `group` joins surviving children and records negation/combinator. */
const joinGroup: FoldHandlers<string>["group"] = (node, children) => {
  const combined = children.join(node.combinator === "and" ? "&" : "|");
  return node.negated ? `!(${combined})` : combined;
};

const handlers: FoldHandlers<string> = { leaf: keepKindLeaf, group: joinGroup };

describe("foldCondition", () => {
  test("a leaf returning null is dropped", () => {
    const unrestricted: ConditionNode = {
      type: "predicate",
      operand: { type: "property", propertyId: "status" },
      op: "is_not_empty",
    };
    expect(foldCondition(unrestricted, handlers)).toBeNull();
  });

  test("a group whose children are all dropped is dropped without calling group", () => {
    let groupCalls = 0;
    const countingHandlers: FoldHandlers<string> = {
      leaf: keepKindLeaf,
      group: (node, children) => {
        groupCalls += 1;
        return joinGroup(node, children);
      },
    };
    const node: ConditionNode = {
      type: "group",
      combinator: "and",
      children: [
        {
          type: "predicate",
          operand: { type: "property", propertyId: "status" },
          op: "is_not_empty",
        },
        {
          type: "group",
          combinator: "or",
          children: [],
        },
      ],
    };
    expect(foldCondition(node, countingHandlers)).toBeNull();
    // Only the empty nested group would have been eligible, and an empty
    // group is dropped before `group` is ever invoked for it.
    expect(groupCalls).toBe(0);
  });

  test("a nested dropped group does not affect siblings", () => {
    const node: ConditionNode = {
      type: "group",
      combinator: "or",
      children: [
        kindPredicate("task"),
        { type: "group", combinator: "and", children: [] },
      ],
    };
    expect(foldCondition(node, handlers)).toBe("task");
  });

  test("negated reaches the group callback", () => {
    const node: ConditionNode = {
      type: "group",
      combinator: "and",
      negated: true,
      children: [kindPredicate("task")],
    };
    expect(foldCondition(node, handlers)).toBe("!(task)");
  });

  test("order of surviving children is preserved", () => {
    const node: ConditionNode = {
      type: "group",
      combinator: "and",
      children: [
        kindPredicate("task"),
        {
          type: "predicate",
          operand: { type: "property", propertyId: "status" },
          op: "is_not_empty",
        },
        kindPredicate("message"),
        kindPredicate("document"),
      ],
    };
    expect(foldCondition(node, handlers)).toBe("task&message&document");
  });

  test("returns null for a top-level leaf that compiles to nothing", () => {
    expect(
      foldCondition(
        {
          type: "compare",
          left: { type: "formula", expr: "x" },
          op: "eq",
          right: { type: "literal", value: 1 },
        },
        { leaf: () => null, group: joinGroup },
      ),
    ).toBeNull();
  });
});

describe("foldConditions", () => {
  test("returns null when every top-level node is dropped", () => {
    expect(
      foldConditions(
        [
          {
            type: "predicate",
            operand: { type: "property", propertyId: "status" },
            op: "is_not_empty",
          },
          { type: "group", combinator: "or", children: [] },
        ],
        handlers,
      ),
    ).toBeNull();
  });

  test("returns the surviving results, in order, for the caller to combine", () => {
    expect(
      foldConditions(
        [kindPredicate("task"), kindPredicate("message")],
        handlers,
      ),
    ).toEqual(["task", "message"]);
  });

  test("drops nodes that fold to null while keeping the rest", () => {
    expect(
      foldConditions(
        [
          {
            type: "predicate",
            operand: { type: "property", propertyId: "status" },
            op: "is_not_empty",
          },
          kindPredicate("task"),
        ],
        handlers,
      ),
    ).toEqual(["task"]);
  });
});
