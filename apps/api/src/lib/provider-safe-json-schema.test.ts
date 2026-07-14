import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  projectToProviderSafeJsonSchema,
  PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS,
} from "@/api/lib/provider-safe-json-schema";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";

const PROVIDER_SAFE_KEYWORDS = new Set<string>(
  PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS,
);

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

const collectProjectedSchemaKeywords = (
  node: unknown,
  keywords = new Set<string>(),
  parentKeyword: string | null = null,
): Set<string> => {
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectProjectedSchemaKeywords(entry, keywords, parentKeyword);
    }
    return keywords;
  }
  if (typeof node !== "object" || node === null) {
    return keywords;
  }

  for (const [key, value] of Object.entries(node)) {
    if (parentKeyword !== "properties") {
      keywords.add(key);
    }
    collectProjectedSchemaKeywords(value, keywords, key);
  }
  return keywords;
};

const assertOnlyProviderSafeKeywords = (schema: Record<string, unknown>) => {
  for (const keyword of collectProjectedSchemaKeywords(schema)) {
    expect(PROVIDER_SAFE_KEYWORDS.has(keyword)).toBe(true);
  }
};

const schemaPropertyName = fc.constantFrom("query", "limit", "mode", "kind");

const jsonSchemaLiteral = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.integer({ min: -20, max: 20 }),
  fc.boolean(),
  fc.constant(null),
);

const scalarSchema = fc.oneof(
  fc.constant({ type: "string" }),
  fc.constant({ type: "number" }),
  fc.constant({ type: "boolean" }),
  fc.record({
    enum: fc.array(jsonSchemaLiteral, { minLength: 1, maxLength: 4 }),
  }),
  fc.record({
    const: jsonSchemaLiteral,
    type: fc.constantFrom("string", "number", "boolean"),
  }),
);

const objectSchema = fc
  .dictionary(schemaPropertyName, scalarSchema, { minKeys: 1, maxKeys: 4 })
  .map((properties) => ({
    type: "object",
    properties,
    propertyNames: { type: "string" },
    required: Object.keys(properties).slice(0, 2),
  }));

const schemaWithComposition = fc.oneof(
  scalarSchema,
  objectSchema,
  scalarSchema.map((schema) => ({
    anyOf: [schema, { type: "null" }, { const: null }, { enum: [null] }],
  })),
  objectSchema.map((schema) => ({
    allOf: [
      schema,
      {
        additionalProperties: false,
      },
    ],
  })),
  scalarSchema.map((schema) => ({
    oneOf: [schema, { type: "number", exclusiveMinimum: 0 }],
  })),
);

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

    expect(schema).toEqual({
      type: "object",
      properties: {
        templateId: { type: "string" },
        values: { type: "object", additionalProperties: {} },
      },
      required: ["templateId", "values"],
    });
  });

  test("lowers const to enum", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "string",
      const: "cz",
    });

    expect(schema).toEqual({ type: "string", enum: ["cz"] });
    expect(droppedKeywords).toEqual([]);
  });

  test("lowers null const to null type for JSON Schema providers", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        const: null,
      },
      { nullUnionStrategy: "json-schema" },
    );

    expect(schema).toEqual({ type: "null" });
    expect(droppedKeywords).toEqual([]);
  });

  test("preserves the inferred boolean type when dropping a const constraint", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      const: true,
    });

    expect(schema).toEqual({ type: "boolean" });
    expect(droppedKeywords).toEqual(["const"]);
  });

  test("preserves a numeric literal type through the provider tool funnel", () => {
    const inputSchema = projectSchemaInputJsonSchema(
      toTanStackToolSchema(v.strictObject({ count: v.literal(7) })),
      { nullUnionStrategy: "openapi" },
    );

    expect(convertSchemaToJsonSchema(inputSchema)).toEqual({
      type: "object",
      properties: {
        count: { type: "number", enum: [7] },
      },
      required: ["count"],
      additionalProperties: false,
    });
  });

  test("records const when enum already carries the allowed values", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "string",
      const: "cz",
      enum: ["cz", "sk"],
    });

    expect(schema).toEqual({ type: "string", enum: ["cz", "sk"] });
    expect(droppedKeywords).toEqual(["const"]);
  });

  test("preserves enum literals for JSON Schema providers", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        enum: ["ready", true, null, 1],
      },
      { nullUnionStrategy: "json-schema" },
    );

    expect(schema).toEqual({ enum: ["ready", true, null, 1] });
    expect(droppedKeywords).toEqual([]);
  });

  test("filters enum literals that OpenAPI provider schemas do not support", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        enum: ["ready", true, null, 1],
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({ enum: ["ready", 1], nullable: true });
    expect(droppedKeywords).toEqual(["enum[1]"]);
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

  test("merges compatible allOf object constraints before projection", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "object",
      required: ["query"],
      allOf: [
        {
          properties: {
            query: { type: "string", minLength: 1 },
          },
        },
        {
          properties: {
            limit: { type: "number", minimum: 1 },
          },
          required: ["limit"],
        },
      ],
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1 },
      },
      required: ["query", "limit"],
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("merges allOf property refinements before projection", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      allOf: [
        {
          properties: {
            query: { minLength: 1 },
          },
          required: ["query"],
        },
      ],
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
      },
      required: ["query"],
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("keeps merging allOf branches when additionalProperties false is stricter", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "object",
      additionalProperties: false,
      allOf: [
        {
          additionalProperties: { type: "string" },
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      ],
    });

    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("projects allOf branches before merging their constraints", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        $defs: {
          base: {
            properties: {
              kind: { const: "lookup" },
              mode: { enum: ["auto", null] },
            },
            required: ["kind"],
          },
        },
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["lookup"] },
        mode: { enum: ["auto"], nullable: true },
      },
      required: ["kind"],
    });
    expect(droppedKeywords).toEqual(["allOf[0].$ref", "$defs"]);
  });

  test("preserves nullable type arrays for JSON Schema providers", () => {
    const { schema } = projectToProviderSafeJsonSchema(
      {
        type: ["string", "null"],
        description: "maybe a string",
      },
      { nullUnionStrategy: "json-schema" },
    );

    expect(schema).toEqual({
      anyOf: [
        { type: "string", description: "maybe a string" },
        { type: "null", description: "maybe a string" },
      ],
    });
  });

  test("lowers nullable anyOf branches to nullable: true in OpenAPI mode", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "optional instructions",
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      type: "string",
      minLength: 1,
      description: "optional instructions",
      nullable: true,
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("treats null literal anyOf branches as nullable in OpenAPI mode", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        anyOf: [
          { type: "string", minLength: 1 },
          { const: null },
          { enum: [null] },
        ],
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      type: "string",
      minLength: 1,
      nullable: true,
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("preserves literal-null branches across JSON Schema then OpenAPI projection", () => {
    const jsonSchemaPass = projectToProviderSafeJsonSchema(
      {
        anyOf: [{ type: "string", minLength: 1 }, { const: null }],
      },
      { nullUnionStrategy: "json-schema" },
    );
    const openApiPass = projectToProviderSafeJsonSchema(jsonSchemaPass.schema, {
      nullUnionStrategy: "openapi",
    });

    expect(jsonSchemaPass.schema).toEqual({
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    });
    expect(openApiPass.schema).toEqual({
      type: "string",
      minLength: 1,
      nullable: true,
    });
    expect(jsonSchemaPass.droppedKeywords).toEqual([]);
    expect(openApiPass.droppedKeywords).toEqual([]);
  });

  test("merges parent object constraints into anyOf branches without clobbering branch refinements", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        type: "object",
        properties: {
          mode: { type: "string" },
          query: { type: "string" },
        },
        required: ["query"],
        anyOf: [
          {
            properties: {
              query: { minLength: 3 },
            },
            required: ["mode"],
          },
        ],
      },
      { nullUnionStrategy: "json-schema" },
    );

    expect(schema).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            mode: { type: "string" },
            query: { type: "string", minLength: 3 },
          },
          required: ["query", "mode"],
        },
      ],
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("merges parent object constraints before collapsing nullable OpenAPI anyOf branches", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        anyOf: [
          {
            properties: {
              query: { minLength: 3 },
            },
          },
          { const: null },
        ],
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 3 },
      },
      required: ["query"],
      nullable: true,
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("lowers a scalar null type to nullable: true in OpenAPI mode", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        type: "null",
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({ nullable: true });
    expect(droppedKeywords).toEqual([]);
  });

  test("lowers a multi-type union with null in OpenAPI mode", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        type: ["null", "string", "number"],
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      anyOf: [
        { type: "string", nullable: true },
        { type: "number", nullable: true },
      ],
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("lowers a bare type union to anyOf", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: ["string", "number"],
    });

    expect(schema).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(droppedKeywords).toEqual([]);
  });

  test("drops unsupported type values", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: ["uuid", "string", 1],
    });

    expect(schema).toEqual({ type: "string" });
    expect(droppedKeywords).toEqual(["type[0]", "type[2]"]);
  });

  test("re-enters lowerings after collapsing a nullable anyOf branch in OpenAPI mode", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
      {
        anyOf: [
          {
            type: ["string", "number"],
            propertyNames: { type: "string" },
          },
          { type: "null" },
        ],
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      anyOf: [
        { type: "string", nullable: true },
        { type: "number", nullable: true },
      ],
    });
    expect(droppedKeywords).toEqual([
      "anyOf[0].propertyNames",
      "anyOf[1].propertyNames",
    ]);
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
    expect(schema).toEqual({
      type: "array",
      items: {
        anyOf: [
          { type: "string", pattern: "^a" },
          { type: "integer", minimum: 0 },
        ],
      },
    });
  });

  test("collapses tuple-form items to a single provider-safe schema", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "array",
      items: [{ type: "string", propertyNames: {} }, { type: "number" }],
    });

    expect(schema).toEqual({
      type: "array",
      items: {
        anyOf: [{ type: "string" }, { type: "number" }],
      },
    });
    expect(droppedKeywords).toEqual(["items", "items[0].propertyNames"]);
  });

  test("normalizes boolean schema nodes before returning them", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "object",
      properties: {
        allowed: true,
        forbidden: false,
      },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        allowed: {},
        forbidden: {},
      },
    });
    expect(droppedKeywords).toEqual(["properties.forbidden"]);
  });

  test("dereferences local definitions before dropping unsupported ref keywords", () => {
    const { schema, droppedKeywords } = projectToProviderSafeJsonSchema({
      type: "object",
      properties: {
        id: { $ref: "#/$defs/Id" },
      },
      $defs: {
        Id: { type: "string", minLength: 1 },
      },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
      },
    });
    expect(droppedKeywords).toEqual(["properties.id.$ref", "$defs"]);
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

  test("property: projection only emits provider-safe schema keywords", () => {
    fc.assert(
      fc.property(
        schemaWithComposition,
        fc.constantFrom("json-schema", "openapi" as const),
        (input, nullUnionStrategy) => {
          const { schema } = projectToProviderSafeJsonSchema(input, {
            nullUnionStrategy,
          });

          assertOnlyProviderSafeKeywords(schema);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("property: projecting an already projected schema is stable", () => {
    fc.assert(
      fc.property(
        schemaWithComposition,
        fc.constantFrom("json-schema", "openapi" as const),
        (input, nullUnionStrategy) => {
          const first = projectToProviderSafeJsonSchema(input, {
            nullUnionStrategy,
          });
          const second = projectToProviderSafeJsonSchema(first.schema, {
            nullUnionStrategy,
          });

          expect(second.schema).toEqual(first.schema);
          expect(second.droppedKeywords).toEqual([]);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("property: OpenAPI enum nulls become nullable instead of disappearing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.boolean(),
        (values, includeUnsupportedBoolean) => {
          const enumValues = includeUnsupportedBoolean
            ? [...values, null, true]
            : [...values, null];
          const { schema } = projectToProviderSafeJsonSchema(
            { enum: enumValues },
            { nullUnionStrategy: "openapi" },
          );

          expect(schema["nullable"]).toBe(true);
          expect(schema["enum"]).toEqual(values);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("property: compatible allOf property refinements survive projection", () => {
    fc.assert(
      fc.property(
        schemaPropertyName,
        fc.integer({ min: 1, max: 20 }),
        fc.boolean(),
        (propertyName, minLength, closeObject) => {
          const { schema } = projectToProviderSafeJsonSchema({
            type: "object",
            additionalProperties: !closeObject,
            properties: {
              [propertyName]: { type: "string" },
            },
            allOf: [
              {
                additionalProperties: { type: "string" },
                properties: {
                  [propertyName]: { minLength },
                },
                required: [propertyName],
              },
            ],
          });

          expect(schema).toEqual({
            type: "object",
            additionalProperties: closeObject ? false : { type: "string" },
            properties: {
              [propertyName]: { type: "string", minLength },
            },
            required: [propertyName],
          });
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("property: OpenAPI nullable allOf object wrappers keep property contracts", () => {
    fc.assert(
      fc.property(
        schemaPropertyName,
        fc.integer({ min: 1, max: 20 }),
        (propertyName, minLength) => {
          const { schema } = projectToProviderSafeJsonSchema(
            {
              type: ["object", "null"],
              allOf: [
                {
                  type: "object",
                  properties: {
                    [propertyName]: { type: "string", minLength },
                  },
                  required: [propertyName],
                },
              ],
            },
            { nullUnionStrategy: "openapi" },
          );

          expect(schema).toEqual({
            type: "object",
            nullable: true,
            properties: {
              [propertyName]: { type: "string", minLength },
            },
            required: [propertyName],
          });
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("property: OpenAPI nullable oneOf branches collapse to nullable schemas", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("string", "number", "boolean" as const),
        (type) => {
          const { schema } = projectToProviderSafeJsonSchema(
            {
              oneOf: [{ type }, { type: "null" }],
            },
            { nullUnionStrategy: "openapi" },
          );

          expect(schema).toEqual({ type, nullable: true });
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
