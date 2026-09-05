import { describe, expect, test } from "bun:test";

import { normalizeInputKeyCasing, snakeCase } from "./input-key-casing.js";

const schema = {
  type: "object",
  properties: {
    matter_id: { type: "string" },
    reference: { type: "string" },
    entity_id: { type: "string" },
  },
};

describe("normalizeInputKeyCasing", () => {
  test("a camelCase key the schema declares in snake_case is rewritten", () => {
    expect(
      normalizeInputKeyCasing({
        args: { matterId: "m1", reference: "R-1" },
        inputSchema: schema,
      }),
    ).toEqual({
      status: "normalized",
      args: { matter_id: "m1", reference: "R-1" },
    });
  });

  test("a key the schema does not declare in either casing is left for validation", () => {
    const args = { bogusKey: 1 };
    expect(normalizeInputKeyCasing({ args, inputSchema: schema })).toEqual({
      status: "normalized",
      args,
    });
  });

  test("both casings with structurally equal object values are not a conflict", () => {
    expect(
      normalizeInputKeyCasing({
        args: { matterId: { a: 1, b: [2] }, matter_id: { b: [2], a: 1 } },
        inputSchema: schema,
      }),
    ).toEqual({
      status: "normalized",
      args: { matter_id: { b: [2], a: 1 } },
    });
  });

  test("both casings with different values is a conflict, not a silent winner", () => {
    expect(
      normalizeInputKeyCasing({
        args: { matterId: "a", matter_id: "b" },
        inputSchema: schema,
      }),
    ).toEqual({ status: "conflict", camel: "matterId", snake: "matter_id" });
  });

  test("snakeCase", () => {
    expect(snakeCase("matterId")).toBe("matter_id");
    expect(snakeCase("compareWithVersionId")).toBe("compare_with_version_id");
    expect(snakeCase("reference")).toBe("reference");
  });
});
