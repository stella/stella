import { describe, expect, test } from "bun:test";

import {
  withModelPlaceholdersOmitted,
  withNullOptionalsOmitted,
} from "@/api/lib/json-schema-null-optionals";

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    note: { type: "string", minLength: 1 },
    label: { type: "string" },
    mode: { type: "string", enum: ["fast", "slow"] },
    code: { type: "string", pattern: "^[A-Z]+$" },
    either: { anyOf: [{ type: "string", minLength: 1 }, { type: "number" }] },
  },
  required: ["name"],
};

describe("a model's placeholder in an optional field", () => {
  test("null is omitted where the field refuses it", () => {
    expect(
      withModelPlaceholdersOmitted(schema, { name: "draft", note: null }),
    ).toEqual({ name: "draft" });
  });

  test('"" is omitted only where the field refuses it', () => {
    expect(
      withModelPlaceholdersOmitted(schema, {
        code: "",
        either: "",
        label: "",
        mode: "",
        name: "draft",
        note: "",
      }),
    ).toEqual({ label: "", name: "draft" });
  });

  test("a required field keeps its placeholder, so validation still refuses it", () => {
    const required = { ...schema, required: ["name", "note"] };
    expect(
      withModelPlaceholdersOmitted(required, { name: "draft", note: "" }),
    ).toEqual({ name: "draft", note: "" });
  });

  test('the string "null" is a value, not a placeholder', () => {
    expect(
      withModelPlaceholdersOmitted(schema, { name: "draft", note: "null" }),
    ).toEqual({ name: "draft", note: "null" });
  });

  test('the MCP null rule does not read "" as omitted', () => {
    expect(withNullOptionalsOmitted(schema, { name: "d", note: "" })).toEqual({
      name: "d",
      note: "",
    });
  });
});
