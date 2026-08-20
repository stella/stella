import { describe, expect, test } from "bun:test";

import type { RefOperand } from "@stll/conditions";
import { pruneIncomplete } from "@stll/conditions";

import type { FieldOption, FieldValueType } from "./logic";
import { leafFromField, operandsEqual } from "./logic";

describe("operandsEqual", () => {
  test("two distinct path operands are not equal", () => {
    const a: RefOperand = { type: "path", path: "rent" };
    const b: RefOperand = { type: "path", path: "deposit" };
    expect(operandsEqual(a, b)).toBe(false);
  });

  test("two path operands with the same path are equal", () => {
    const a: RefOperand = { type: "path", path: "rent" };
    const b: RefOperand = { type: "path", path: "rent" };
    expect(operandsEqual(a, b)).toBe(true);
  });

  test("property operands compare by propertyId", () => {
    const a: RefOperand = { type: "property", propertyId: "p1" };
    expect(operandsEqual(a, { type: "property", propertyId: "p1" })).toBe(true);
    expect(operandsEqual(a, { type: "property", propertyId: "p2" })).toBe(
      false,
    );
  });

  test("builtin operands compare by field", () => {
    const a: RefOperand = { type: "builtin", field: "status" };
    expect(operandsEqual(a, { type: "builtin", field: "status" })).toBe(true);
    expect(operandsEqual(a, { type: "builtin", field: "priority" })).toBe(
      false,
    );
  });

  test("formula operands compare by expression", () => {
    const a: RefOperand = { type: "formula", expr: "rent * 12" };
    expect(operandsEqual(a, { type: "formula", expr: "rent * 12" })).toBe(true);
    expect(operandsEqual(a, { type: "formula", expr: "rent * 6" })).toBe(false);
  });

  test("operands of different types are never equal", () => {
    const a: RefOperand = { type: "path", path: "rent" };
    const b: RefOperand = { type: "property", propertyId: "rent" };
    expect(operandsEqual(a, b)).toBe(false);
  });
});

describe("leafFromField", () => {
  // A seeded row must read as incomplete. Total over `FieldValueType`, and the
  // cases are derived from it, so a new value type cannot land untested.
  const SEEDED = {
    text: { valueType: "text", type: "text" },
    "single-select": { valueType: "single-select", type: "single-select" },
    "multi-select": { valueType: "multi-select", type: "multi-select" },
    date: { valueType: "date", type: "date" },
    int: { valueType: "int", type: "int" },
    money: { valueType: "money", type: "money" },
    person: { valueType: "person", type: "person" },
    kind: { valueType: "kind", type: "text" },
    status: { valueType: "status", type: "single-select" },
    priority: { valueType: "priority", type: "single-select" },
  } as const satisfies Record<
    FieldValueType,
    Pick<FieldOption, "valueType" | "type">
  >;

  for (const seeded of Object.values(SEEDED)) {
    test(`a seeded ${seeded.valueType} row prunes away`, () => {
      const field: FieldOption = {
        ...seeded,
        operand: { type: "property", propertyId: "p1" },
        label: seeded.valueType,
      };
      expect(pruneIncomplete(leafFromField(field))).toBeNull();
    });
  }
});
