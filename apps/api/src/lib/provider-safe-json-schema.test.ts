import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";

const collectKeywords = (
  node: unknown,
  keywords = new Set<string>(),
): Set<string> => {
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectKeywords(entry, keywords);
    }
    return keywords;
  }
  if (typeof node !== "object" || node === null) {
    return keywords;
  }

  for (const [key, value] of Object.entries(node)) {
    keywords.add(key);
    collectKeywords(value, keywords);
  }
  return keywords;
};

describe("projectToProviderSafeJsonSchema", () => {
  test("drops propertyNames from the fill_template repro while keeping additionalProperties", () => {
    const input = {
      type: "object",
      properties: {
        templateId: { type: "string" },
        values: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {},
        },
      },
      required: ["templateId", "values"],
    };

    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(input);

    expect(collectKeywords(schema).has("propertyNames")).toBe(false);
    expect(droppedKeywords).toContain("properties.values.propertyNames");

    const values = (schema["properties"] as Record<string, unknown>)["values"];
    expect(values).toEqual({ type: "object", additionalProperties: {} });
  });

  test("lowers const to enum", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "string",
      const: "cz",
    });

    expect(schema).toEqual({ type: "string", enum: ["cz"] });
    expect(droppedKeywords).toEqual([]);
  });

  test("lowers oneOf to anyOf and recurses into branches", () => {
    const { schema } = projectToProviderSafeJsonSchema({
      oneOf: [
        { type: "object", properties: { a: { type: "string", const: "x" } } },
        { type: "number", exclusiveMinimum: 0 },
      ],
    });

    expect(schema).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string", enum: ["x"] } },
        },
        { type: "number" },
      ],
    });
    expect(collectKeywords(schema).has("oneOf")).toBe(false);
    expect(collectKeywords(schema).has("exclusiveMinimum")).toBe(false);
  });

  test("lowers a nullable type array to nullable: true", () => {
    const { schema } = projectToProviderSafeJsonSchema({
      type: ["string", "null"],
      description: "maybe a string",
    });

    expect(schema).toEqual({
      type: "string",
      nullable: true,
      description: "maybe a string",
    });
  });

  test("lowers a scalar null type to nullable: true", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "null",
    });

    expect(schema).toEqual({ nullable: true });
    expect(droppedKeywords).toEqual([]);
  });

  test("lowers a multi-type union with null regardless of position", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: ["null", "string", "number"],
    });

    expect(schema).toEqual({ type: "string", nullable: true });
    expect(droppedKeywords).toEqual(["type[1]"]);
  });

  test("keeps the first entry of a bare type union and records the rest", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: ["string", "number"],
    });

    expect(schema).toEqual({ type: "string" });
    expect(droppedKeywords).toEqual(["type[1]"]);
  });

  test("recurses through items and anyOf", () => {
    const { schema } = projectToProviderSafeJsonSchema({
      type: "array",
      items: {
        anyOf: [
          { type: "string", pattern: "^a", propertyNames: { type: "string" } },
          { type: "integer", minimum: 0 },
        ],
      },
    });

    expect(collectKeywords(schema).has("propertyNames")).toBe(false);
    const items = schema["items"] as Record<string, unknown>;
    const branches = items["anyOf"] as Record<string, unknown>[];
    expect(branches[0]).toEqual({ type: "string", pattern: "^a" });
    expect(branches[1]).toEqual({ type: "integer", minimum: 0 });
  });

  test("is idempotent: projecting a projected schema drops nothing", () => {
    const input = {
      type: "object",
      properties: {
        values: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {},
        },
      },
      required: ["values"],
    };

    const once = projectToProviderSafeJsonSchema(input);
    const twice = projectToProviderSafeJsonSchema(once.schema);

    expect(twice.droppedKeywords).toEqual([]);
    expect(twice.schema).toEqual(once.schema);
  });

  test("projects the valibot v.record shape through the tool funnel", () => {
    const inputSchema = toTanStackToolSchema(
      v.strictObject({ values: v.record(v.string(), v.unknown()) }),
    );

    const serialized = convertSchemaToJsonSchema(inputSchema);

    expect(collectKeywords(serialized).has("propertyNames")).toBe(false);
  });
});
