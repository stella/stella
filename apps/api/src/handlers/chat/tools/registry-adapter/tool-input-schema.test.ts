import { describe, expect, test } from "bun:test";

import type { JsonSchema } from "@/api/mcp/tool-types";

import { toToolInputSchema } from "./tool-input-schema";

describe("toToolInputSchema", () => {
  test("preserves every JSON Schema keyword and boolean subschema", () => {
    const schema = {
      additionalProperties: false,
      properties: {
        choice: {
          anyOf: [false, { const: null }, { type: "string" }],
        },
        count: { maximum: 20, minimum: 1, type: "integer" },
        query: { format: "text", maxLength: 500, type: "string" },
      },
      required: ["query"],
      type: "object",
    } as const satisfies JsonSchema;

    expect(JSON.stringify(toToolInputSchema(schema))).toBe(
      JSON.stringify(schema),
    );
  });

  test("returns a detached mutable projection", () => {
    const schema = {
      properties: { query: { enum: ["one", "two"], type: "string" } },
      required: ["query"],
      type: "object",
    } as const satisfies JsonSchema;

    const projected = toToolInputSchema(schema);
    expect(projected.required).toBeDefined();
    expect(projected.properties?.["query"]?.enum).toBeDefined();
    if (
      projected.required === undefined ||
      projected.properties?.["query"]?.enum === undefined
    ) {
      throw new Error("Expected the projected schema paths to exist");
    }
    projected.required.push("other");
    projected.properties["query"].enum.push("three");

    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.query.enum).toEqual(["one", "two"]);
  });

  test("omits unavailable top-level properties without changing the source schema", () => {
    const schema = {
      properties: {
        docx_base64: { type: "string" },
        file: { type: "object" },
        template_id: { type: "string" },
      },
      required: ["file", "template_id"],
      type: "object",
    } as const satisfies JsonSchema;

    const projected = toToolInputSchema(schema, ["file"]);

    expect(projected.properties?.["file"]).toBeUndefined();
    expect(projected.required).toEqual(["template_id"]);
    expect(projected.properties?.["docx_base64"]).toEqual({
      type: "string",
    });
    expect(schema.properties.file).toEqual({ type: "object" });
    expect(schema.required).toEqual(["file", "template_id"]);
  });
});
