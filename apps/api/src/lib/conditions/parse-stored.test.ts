import { describe, expect, test } from "bun:test";

import { parseStoredCondition } from "./parse-stored";

describe("stored workflow conditions", () => {
  test("preserves legacy scalar gates", () => {
    expect(
      parseStoredCondition(
        { version: 1, type: "string", operator: "eq", value: "signed" },
        "status-property",
      ),
    ).toEqual({
      status: "valid",
      condition: {
        type: "compare",
        left: { type: "property", propertyId: "status-property" },
        op: "eq",
        right: { type: "literal", value: "signed" },
      },
    });
  });

  test("preserves legacy multi-select gates", () => {
    expect(
      parseStoredCondition(
        {
          version: 1,
          type: "string-array",
          operator: "contains-every",
          value: ["approved", "signed"],
        },
        "status-property",
      ),
    ).toEqual({
      status: "valid",
      condition: {
        type: "predicate",
        operand: { type: "property", propertyId: "status-property" },
        op: "contains_all",
        value: ["approved", "signed"],
      },
    });
  });

  test("preserves null and rejects unsupported formula gates", () => {
    expect(parseStoredCondition(null, "status-property")).toEqual({
      status: "valid",
      condition: null,
    });
    const condition = {
      type: "compare" as const,
      left: { type: "formula" as const, expr: "rent * 12" },
      op: "eq" as const,
      right: { type: "literal" as const, value: 1200 },
    };
    expect(parseStoredCondition(condition, "status-property")).toEqual({
      status: "invalid",
    });
  });

  test("marks unrecognized stored gates as invalid", () => {
    expect(
      parseStoredCondition({ type: "unknown" }, "status-property"),
    ).toEqual({ status: "invalid" });
  });
});
