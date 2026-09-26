import { describe, expect, test } from "bun:test";

import {
  withModelPlaceholdersOmitted,
  withNullOptionalsOmitted,
} from "@/api/lib/json-schema/null-optionals";

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

  test('"" is omitted where the field\'s format refuses it', () => {
    const formatted = {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        on: { type: "string", format: "date" },
        tag: { type: "string", format: "x-free-text" },
      },
    };
    expect(
      withModelPlaceholdersOmitted(formatted, { id: "", on: "", tag: "" }),
    ).toEqual({ tag: "" });
  });

  test("an OpenAPI nullable field keeps its null", () => {
    const projected = {
      type: "object",
      properties: {
        name: { type: "string" },
        note: { type: "string", nullable: true },
      },
      required: ["name"],
    };
    expect(
      withModelPlaceholdersOmitted(projected, { name: "draft", note: null }),
    ).toEqual({ name: "draft", note: null });
  });

  test("a pattern that does not compile leaves the value as sent", () => {
    const loose = {
      type: "object",
      properties: { slug: { type: "string", pattern: String.raw`^[a-z\_]+$` } },
      patternProperties: { [String.raw`^x\-`]: { type: "string" } },
    };
    expect(
      withModelPlaceholdersOmitted(loose, { slug: "", "x-tag": null }),
    ).toEqual({ slug: "", "x-tag": null });
  });

  test('the MCP null rule does not read "" as omitted', () => {
    expect(withNullOptionalsOmitted(schema, { name: "d", note: "" })).toEqual({
      name: "d",
      note: "",
    });
  });
});
