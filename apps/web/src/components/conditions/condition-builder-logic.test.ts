import { describe, expect, test } from "bun:test";

import type { RefOperand } from "@stll/conditions";

import { operandsEqual } from "./condition-builder-logic";

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
