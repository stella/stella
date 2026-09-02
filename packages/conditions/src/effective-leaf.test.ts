import { describe, expect, test } from "bun:test";

import { isEffectiveLeaf } from "./effective-leaf";
import type { CompareNode, PredicateNode } from "./schema";

describe("isEffectiveLeaf — compare", () => {
  test("a complete property compare is effective", () => {
    const node: CompareNode = {
      type: "compare",
      left: { type: "property", propertyId: "p1" },
      op: "eq",
      right: { type: "literal", value: "alpha" },
    };
    expect(isEffectiveLeaf(node)).toBe(true);
  });

  test("a complete builtin compare is effective", () => {
    const node: CompareNode = {
      type: "compare",
      left: { type: "builtin", field: "status" },
      op: "gt",
      right: { type: "literal", value: "open" },
    };
    expect(isEffectiveLeaf(node)).toBe(true);
  });

  test("an empty literal is incomplete for an ordered comparison", () => {
    const node: CompareNode = {
      type: "compare",
      left: { type: "property", propertyId: "p1" },
      op: "lt",
      right: { type: "literal", value: "" },
    };
    expect(isEffectiveLeaf(node)).toBe(false);
  });

  test("an empty literal is incomplete for eq/neq too", () => {
    const eqNode: CompareNode = {
      type: "compare",
      left: { type: "property", propertyId: "p1" },
      op: "eq",
      right: { type: "literal", value: "" },
    };
    const neqNode: CompareNode = { ...eqNode, op: "neq" };
    expect(isEffectiveLeaf(eqNode)).toBe(false);
    expect(isEffectiveLeaf(neqNode)).toBe(false);
  });

  test("a formula operand on either side has no SQL form", () => {
    const leftFormula: CompareNode = {
      type: "compare",
      left: { type: "formula", expr: "rent * 12" },
      op: "eq",
      right: { type: "literal", value: "100" },
    };
    const rightFormula: CompareNode = {
      type: "compare",
      left: { type: "property", propertyId: "p1" },
      op: "eq",
      right: { type: "formula", expr: "rent * 12" },
    };
    expect(isEffectiveLeaf(leftFormula)).toBe(false);
    expect(isEffectiveLeaf(rightFormula)).toBe(false);
  });

  test("a non-literal right operand is unsupported", () => {
    const node: CompareNode = {
      type: "compare",
      left: { type: "property", propertyId: "p1" },
      op: "eq",
      right: { type: "property", propertyId: "p2" },
    };
    expect(isEffectiveLeaf(node)).toBe(false);
  });

  test("a left operand that is neither property nor builtin is unsupported", () => {
    const kindLeft: CompareNode = {
      type: "compare",
      left: { type: "kind" },
      op: "eq",
      right: { type: "literal", value: "task" },
    };
    const pathLeft: CompareNode = {
      type: "compare",
      left: { type: "path", path: "a" },
      op: "eq",
      right: { type: "literal", value: "task" },
    };
    const literalLeft: CompareNode = {
      type: "compare",
      left: { type: "literal", value: "x" },
      op: "eq",
      right: { type: "literal", value: "task" },
    };
    expect(isEffectiveLeaf(kindLeft)).toBe(false);
    expect(isEffectiveLeaf(pathLeft)).toBe(false);
    expect(isEffectiveLeaf(literalLeft)).toBe(false);
  });
});

describe("isEffectiveLeaf — predicate: kind", () => {
  test("kind in […] with a payload is effective", () => {
    const node: PredicateNode = {
      type: "predicate",
      operand: { type: "kind" },
      op: "in",
      value: ["task"],
    };
    expect(isEffectiveLeaf(node)).toBe(true);
  });

  test("kind in [] (empty payload) is incomplete", () => {
    const node: PredicateNode = {
      type: "predicate",
      operand: { type: "kind" },
      op: "in",
      value: [],
    };
    expect(isEffectiveLeaf(node)).toBe(false);
  });

  test("a kind predicate op other than in is unsupported", () => {
    const node: PredicateNode = {
      type: "predicate",
      operand: { type: "kind" },
      op: "is_not_empty",
    };
    expect(isEffectiveLeaf(node)).toBe(false);
  });
});

describe("isEffectiveLeaf — predicate: builtin", () => {
  test("builtin in […] with a payload is effective", () => {
    const node: PredicateNode = {
      type: "predicate",
      operand: { type: "builtin", field: "status" },
      op: "in",
      value: ["open"],
    };
    expect(isEffectiveLeaf(node)).toBe(true);
  });

  test("builtin in [] (empty payload) is incomplete", () => {
    const node: PredicateNode = {
      type: "predicate",
      operand: { type: "builtin", field: "status" },
      op: "in",
      value: [],
    };
    expect(isEffectiveLeaf(node)).toBe(false);
  });

  test("builtin is_empty / is_not_empty need no payload and are effective", () => {
    const isEmpty: PredicateNode = {
      type: "predicate",
      operand: { type: "builtin", field: "priority" },
      op: "is_empty",
    };
    const isNotEmpty: PredicateNode = { ...isEmpty, op: "is_not_empty" };
    expect(isEffectiveLeaf(isEmpty)).toBe(true);
    expect(isEffectiveLeaf(isNotEmpty)).toBe(true);
  });

  test("builtin does not support contains/starts_with/ends_with/contains_all/is_truthy", () => {
    const unsupportedOps = [
      "is_truthy",
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
      "contains_all",
    ] as const;
    for (const op of unsupportedOps) {
      const node: PredicateNode = {
        type: "predicate",
        operand: { type: "builtin", field: "status" },
        op,
        value: "open",
      };
      expect(isEffectiveLeaf(node)).toBe(false);
    }
  });
});

describe("isEffectiveLeaf — predicate: property", () => {
  test("property is_empty / is_not_empty need no payload and are effective", () => {
    const isEmpty: PredicateNode = {
      type: "predicate",
      operand: { type: "property", propertyId: "p1" },
      op: "is_empty",
    };
    const isNotEmpty: PredicateNode = { ...isEmpty, op: "is_not_empty" };
    expect(isEffectiveLeaf(isEmpty)).toBe(true);
    expect(isEffectiveLeaf(isNotEmpty)).toBe(true);
  });

  test("property is_truthy has no SQL form regardless of payload", () => {
    const node: PredicateNode = {
      type: "predicate",
      operand: { type: "property", propertyId: "p1" },
      op: "is_truthy",
    };
    expect(isEffectiveLeaf(node)).toBe(false);
  });

  test("contains/not_contains/starts_with/ends_with need a non-empty value", () => {
    const valueOps = [
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
    ] as const;
    for (const op of valueOps) {
      const missing: PredicateNode = {
        type: "predicate",
        operand: { type: "property", propertyId: "p1" },
        op,
      };
      const blank: PredicateNode = { ...missing, value: "" };
      const present: PredicateNode = { ...missing, value: "alpha" };
      expect(isEffectiveLeaf(missing)).toBe(false);
      expect(isEffectiveLeaf(blank)).toBe(false);
      expect(isEffectiveLeaf(present)).toBe(true);
    }
  });

  test("a text op whose array payload is blank once coerced is incomplete", () => {
    // The compiler matches these ops against String(value): [""] is "" and
    // would otherwise compile to a match-everything pattern.
    for (const op of [
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
    ] as const) {
      expect(
        isEffectiveLeaf({
          type: "predicate",
          operand: { type: "property", propertyId: "p" },
          op,
          value: [""],
        }),
      ).toBe(false);
      expect(
        isEffectiveLeaf({
          type: "predicate",
          operand: { type: "property", propertyId: "p" },
          op,
          value: ["a"],
        }),
      ).toBe(true);
    }
  });

  test("contains_all / in need a non-empty payload array", () => {
    const arrayOps = ["contains_all", "in"] as const;
    for (const op of arrayOps) {
      const empty: PredicateNode = {
        type: "predicate",
        operand: { type: "property", propertyId: "p1" },
        op,
        value: [],
      };
      const present: PredicateNode = { ...empty, value: ["alpha"] };
      expect(isEffectiveLeaf(empty)).toBe(false);
      expect(isEffectiveLeaf(present)).toBe(true);
    }
  });
});

describe("isEffectiveLeaf — predicate: unsupported operand types", () => {
  test("path/formula/literal operands are never effective", () => {
    const pathNode: PredicateNode = {
      type: "predicate",
      operand: { type: "path", path: "a" },
      op: "is_not_empty",
    };
    const formulaNode: PredicateNode = {
      type: "predicate",
      operand: { type: "formula", expr: "rent * 12" },
      op: "is_not_empty",
    };
    const literalNode: PredicateNode = {
      type: "predicate",
      operand: { type: "literal", value: "x" },
      op: "is_not_empty",
    };
    expect(isEffectiveLeaf(pathNode)).toBe(false);
    expect(isEffectiveLeaf(formulaNode)).toBe(false);
    expect(isEffectiveLeaf(literalNode)).toBe(false);
  });
});
