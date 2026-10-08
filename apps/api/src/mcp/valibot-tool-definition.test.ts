import { describe, expect, test, expectTypeOf } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  DECISION_IDENTIFIER_MAX_LENGTH,
  identifierValueSchema,
  structuredIdentifierValueSchema,
} from "@stll/legal-ast/decision-identifier";
import { blockSchema } from "@stll/legal-ast/document-ast";
import { propertyConfig } from "@stll/property-testing";

import type { McpToolHandler } from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import { nullAsAbsent, toolDataResult } from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineMcpToolOutput,
  defineProjectedMcpToolOutput,
  defineValibotMcpTool,
  deriveUncompactedMcpOutputSchema,
} from "@/api/mcp/valibot-tool-definition";
import {
  compileWireSchema,
  createWireSchemaValidator,
  schemaComparisonArbitrary,
} from "@/api/tests/helpers/wire-json-schema";

const LITERALS = ["a", "b", "c", 1, 2, true] as const;
const DISCRIMINATORS = ["x", "y", "z"] as const;

const leafSourceArbitrary: fc.Arbitrary<v.GenericSchema> = fc.oneof(
  fc.constant(v.string()),
  fc
    .tuple(fc.nat({ max: 3 }), fc.nat({ max: 4 }))
    .map(([min, extra]) =>
      v.pipe(v.string(), v.minLength(min), v.maxLength(min + extra)),
    ),
  fc.constant(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9))),
  fc.constant(v.boolean()),
  fc
    .uniqueArray(fc.constantFrom("a", "b", "c", "d"), {
      minLength: 1,
      maxLength: 3,
    })
    .map((options) => v.picklist(options)),
  fc
    .uniqueArray(fc.constantFrom(...LITERALS), { minLength: 1, maxLength: 4 })
    .map((options) => v.union(options.map((option) => v.literal(option)))),
);

/**
 * Output sources built from the shapes the registry uses: literals and
 * picklists, nullable values, closed objects with optional keys, arrays, and
 * discriminated unions whose branches the generator merges property-wise.
 */
const { node: nodeSourceArbitrary } = fc.letrec<{
  node: v.GenericSchema;
  object: v.GenericSchema;
}>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leafSourceArbitrary,
    tie("node").map((schema) => v.nullable(schema)),
    tie("node").map((schema) => v.array(schema)),
    tie("object"),
    fc
      .array(tie("node"), { minLength: 2, maxLength: DISCRIMINATORS.length })
      .map((values) =>
        v.union(
          values.map((value, index) =>
            v.strictObject({
              kind: v.literal(DISCRIMINATORS[index] ?? "x"),
              value,
            }),
          ),
        ),
      ),
  ),
  object: fc
    .dictionary(
      fc.constantFrom("p", "q", "r"),
      fc.tuple(tie("node"), fc.boolean()),
      { maxKeys: 3 },
    )
    .map((entries) =>
      v.strictObject(
        Object.fromEntries(
          Object.entries(entries).map(([name, [schema, optional]]) => [
            name,
            optional ? v.optional(schema) : schema,
          ]),
        ),
      ),
    ),
}));

const outputSourceArbitrary = nodeSourceArbitrary.map((value) =>
  v.strictObject({ value }),
);

describe("Valibot-backed MCP tool definitions", () => {
  test("derives executable and wire output contracts from one schema", () => {
    const outputSchema = v.strictObject({
      id: v.string(),
      count: v.pipe(v.number(), v.integer()),
    });
    const contract = defineMcpToolOutput(outputSchema);

    expect(contract.outputSchemaSource).toBe(outputSchema);
    expect(contract.outputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        count: { type: "integer" },
      },
      required: ["id", "count"],
      additionalProperties: false,
    });
    expect(contract.outputSchema).not.toHaveProperty("$schema");
  });

  test("supports an explicit compact projection without changing its schema", () => {
    const outputSchema = v.strictObject({ result: v.unknown() });
    const contract = defineProjectedMcpToolOutput(outputSchema, (result) => ({
      result,
    }));

    expect(contract.project([1, 2])).toEqual({ result: [1, 2] });
    expect(contract.outputSchema).toEqual({
      type: "object",
      properties: { result: {} },
      required: ["result"],
      additionalProperties: false,
    });
  });

  test("projects only the closed chat string-id custom vocabulary", () => {
    const contract = defineChatProjectionMcpToolOutput(
      v.strictObject({
        matterId: v.custom<string>(
          (value) => typeof value === "string",
          "Expected a matter identifier",
        ),
      }),
    );
    expect(contract.outputSchema).toEqual({
      type: "object",
      properties: { matterId: { type: "string" } },
      required: ["matterId"],
      additionalProperties: false,
    });

    expect(() =>
      defineChatProjectionMcpToolOutput(
        v.strictObject({ score: v.custom<number>(() => true) }),
      ),
    ).toThrow('The "custom" schema cannot be converted to JSON Schema');
  });

  test("safely merges output object unions without dropping possible fields", () => {
    const contract = defineMcpToolOutput(
      v.union([
        v.strictObject({ type: v.literal("left"), left: v.string() }),
        v.strictObject({ type: v.literal("right"), right: v.number() }),
      ]),
    );

    expect(contract.outputSchema).toEqual({
      type: "object",
      properties: {
        type: { enum: ["left", "right"], type: "string" },
        left: { type: "string" },
        right: { type: "number" },
      },
      required: ["type"],
      additionalProperties: false,
    });
  });

  test("merges literal alternatives of one type and nothing else", () => {
    const contract = defineMcpToolOutput(
      v.strictObject({
        status: v.union([
          v.literal("found"),
          v.picklist(["pending", "found"]),
          v.literal(1),
          v.literal("missing"),
          v.literal(2),
        ]),
        mixed: v.union([
          v.literal("none"),
          v.pipe(v.string(), v.minLength(3)),
          v.literal("all"),
        ]),
      }),
    );

    expect(contract.outputSchema).toMatchObject({
      properties: {
        status: {
          anyOf: [
            { enum: ["found", "pending", "missing"], type: "string" },
            { enum: [1, 2], type: "number" },
          ],
        },
        mixed: {
          anyOf: [
            { enum: ["none", "all"], type: "string" },
            { type: "string", minLength: 3 },
          ],
        },
      },
    });
  });

  test("writes a nullable value as a type array only where that is exact", () => {
    const contract = defineMcpToolOutput(
      v.strictObject({
        label: v.nullable(v.pipe(v.string(), v.maxLength(8))),
        tags: v.nullable(v.array(v.string())),
        color: v.nullable(v.picklist(["red", "green"])),
        either: v.nullable(v.union([v.string(), v.number()])),
      }),
    );

    expect(contract.outputSchema).toMatchObject({
      properties: {
        label: { type: ["string", "null"], maxLength: 8 },
        tags: { type: ["array", "null"], items: { type: "string" } },
        // `enum` would reject null beside a type array: the anyOf stays.
        color: {
          anyOf: [{ enum: ["red", "green"], type: "string" }, { type: "null" }],
        },
        either: {
          anyOf: [
            { anyOf: [{ type: "string" }, { type: "number" }] },
            { type: "null" },
          ],
        },
      },
    });
  });

  test("compacted output schemas accept exactly what the uncompacted projection accepts", () => {
    const validator = createWireSchemaValidator();
    fc.assert(
      fc.property(
        outputSourceArbitrary.chain((source) => {
          const compacted = defineMcpToolOutput(source).outputSchema;
          const uncompacted = deriveUncompactedMcpOutputSchema(source);
          return fc.tuple(
            fc.constant({ compacted, uncompacted }),
            fc.array(schemaComparisonArbitrary([uncompacted, compacted]), {
              minLength: 25,
              maxLength: 25,
            }),
          );
        }),
        ([{ compacted, uncompacted }, values]) => {
          expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(
            JSON.stringify(uncompacted).length,
          );
          const acceptsCompacted = compileWireSchema(validator, compacted);
          const acceptsUncompacted = compileWireSchema(validator, uncompacted);
          for (const value of values) {
            expect(acceptsCompacted(value)).toBe(acceptsUncompacted(value));
          }
        },
      ),
      propertyConfig({ numRuns: 150 }),
    );
  });

  test("keeps list-item fields visible while widening deeper object internals", () => {
    const contract = defineMcpToolOutput(
      v.strictObject({
        items: v.array(
          v.strictObject({
            id: v.string(),
            details: v.strictObject({ value: v.string() }),
          }),
        ),
      }),
    );

    expect(contract.outputSchema).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              details: { type: "object", additionalProperties: true },
            },
            required: ["id", "details"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    });
  });

  test("binds identity output schemas to their named handler result", () => {
    const definition = defineValibotMcpTool({
      consumesServices: false,
      access: "read",
      readClass: "tenant",
      annotations: {
        title: "Read example",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      },
      anonymized: { exposure: "passthrough" },
      description: "Read an example.",
      inputSchema: nullAsAbsent(v.strictObject({})),
      name: "read_example",
      scope: "stella:read",
    });
    const definitions = [definition] as const;
    const outputs = {
      read_example: defineMcpToolOutput(v.strictObject({ id: v.string() })),
    };
    const handlers = {
      read_example: () => toolDataResult({ id: "example_1" }),
    } satisfies Record<"read_example", McpToolHandler<{ id: string }>>;

    defineMcpToolSet(definitions, handlers, outputs);

    const mismatchedHandlers = {
      read_example: () => toolDataResult({ count: 1 }),
    } satisfies Record<"read_example", McpToolHandler<{ count: number }>>;
    // @ts-expect-error -- the handler data must equal the named identity output contract.
    defineMcpToolSet(definitions, mismatchedHandlers, outputs);
  });

  test("derives the wire schema from the handler's strict runtime schema", () => {
    const inputSchema = nullAsAbsent(
      v.strictObject({
        from: v.pipe(
          v.string(),
          v.isoTimestamp(),
          v.description("Inclusive ISO timestamp"),
        ),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
            v.description("Maximum rows"),
          ),
        ),
        score: v.optional(
          v.pipe(
            v.number(),
            v.finite(),
            v.description("Finite relevance score"),
          ),
        ),
      }),
    );
    const definition = defineValibotMcpTool({
      consumesServices: false,
      access: "read",
      readClass: "tenant",
      annotations: {
        title: "Read example",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      },
      anonymized: { exposure: "passthrough" },
      description: "Read an example.",
      inputSchema,
      jsonSchemaProjectionWaiver: {
        ignoreActions: ["finite"],
        reason: "JSON numbers are finite on the MCP wire.",
      },
      name: "read_example",
      scope: "stella:read",
    });

    expectTypeOf(definition.name).toEqualTypeOf<"read_example">();
    expectTypeOf(definition.inputSchemaSource).toEqualTypeOf<
      typeof inputSchema
    >();
    expect(definition.inputSchemaSource).toBe(inputSchema);
    expect(definition).not.toHaveProperty("jsonSchemaProjectionWaiver");
    expect(definition.inputSchema).toEqual({
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date-time",
          description: "Inclusive ISO timestamp",
        },
        // A bounded `limit` is a page size by convention: clamped, not refused.
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "Maximum rows. Use a JSON number; a value outside the range is clamped to it.",
          "x-stella-agent-input": { kind: "number", range: "clamp" },
        },
        score: {
          type: "number",
          description: "Finite relevance score",
        },
      },
      required: ["from"],
      additionalProperties: false,
    });
    expect(definition.inputSchema).not.toHaveProperty("$schema");

    // The handler parses the exact schema object supplied to the definition;
    // generated JSON is transport metadata, never a second runtime validator.
    expect(
      v.safeParse(definition.inputSchemaSource, {
        from: "2026-08-23T12:00:00Z",
        limit: 20,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(definition.inputSchemaSource, {
        from: "August 23, 2026",
        limit: 20,
        ignored: true,
      }).success,
    ).toBe(false);
  });

  test("projects variants and literals into the provider-safe dialect", () => {
    // `oneOf` and `const` are what the export emits; neither survives the chat
    // surface's provider-safe check, and both have exact equivalents.
    const definition = defineValibotMcpTool({
      consumesServices: false,
      access: "write",
      permissions: { type: "all", permissions: { entity: ["update"] } },
      accountAccess: "sandbox",
      annotations: {
        title: "Set example",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      description: "Set an example.",
      inputSchema: nullAsAbsent(
        v.strictObject({
          content: v.variant("type", [
            v.strictObject({ type: v.literal("text"), value: v.string() }),
            v.strictObject({ type: v.literal("count"), value: v.number() }),
          ]),
        }),
      ),
      name: "set_example",
      scope: "stella:documents_write",
    });

    expect(definition.inputSchema.properties?.["content"]).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            type: { enum: ["text"], type: "string" },
            value: { type: "string" },
          },
          required: ["type", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { enum: ["count"], type: "string" },
            value: { type: "number" },
          },
          required: ["type", "value"],
          additionalProperties: false,
        },
      ],
    });
    const serialized = JSON.stringify(definition.inputSchema);
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).not.toContain('"const"');
  });

  test("binds explicit normalization metadata to the projected field", () => {
    const definition = defineValibotMcpTool({
      consumesServices: false,
      access: "write",
      permissions: { type: "all", permissions: { entity: ["update"] } },
      accountAccess: "sandbox",
      annotations: {
        title: "Configure example",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      description: "Configure an example.",
      inputSchema: nullAsAbsent(
        v.strictObject({
          fields: v.array(
            v.strictObject({
              date_format: v.optional(
                v.strictObject({ locale: v.string(), style: v.string() }),
              ),
            }),
          ),
        }),
      ),
      inputNormalization: {
        "fields[].date_format": {
          kind: "date-format",
          invalidValueDisposition: "handler-owned",
        },
      },
      name: "configure_example",
      scope: "stella:documents_write",
    });

    expect(definition.inputSchema.properties?.["fields"]).toMatchObject({
      items: {
        properties: {
          date_format: {
            "x-stella-agent-input": {
              kind: "date-format",
              invalidValueDisposition: "handler-owned",
            },
            description: expect.stringContaining("BCP-47 locale"),
          },
        },
      },
    });
    expect(definition).not.toHaveProperty("inputNormalization");
  });

  test("rejects an explicit normalization path that does not exist", () => {
    expect(() =>
      defineValibotMcpTool({
        consumesServices: false,
        access: "read",
        readClass: "tenant",
        annotations: {
          title: "Read example",
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        anonymized: { exposure: "passthrough" },
        description: "Read an example.",
        inputSchema: nullAsAbsent(v.strictObject({ value: v.string() })),
        inputNormalization: { missing: { kind: "locale" } },
        name: "read_example",
        scope: "stella:read",
      }),
    ).toThrow("Agent input normalization path does not exist: missing");
  });

  test("rejects an unsupported action without an explicit projection waiver", () => {
    expect(() =>
      defineValibotMcpTool({
        consumesServices: false,
        access: "read",
        readClass: "tenant",
        annotations: {
          title: "Read example",
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        anonymized: { exposure: "passthrough" },
        description: "Read an example.",
        inputSchema: nullAsAbsent(
          v.strictObject({
            score: v.pipe(v.number(), v.finite()),
          }),
        ),
        name: "read_example",
        scope: "stella:read",
      }),
    ).toThrow(/finite/u);
  });

  test("rejects an input schema that admits unknown root properties", () => {
    expect(() =>
      defineValibotMcpTool({
        consumesServices: false,
        access: "read",
        readClass: "tenant",
        annotations: {
          title: "Read example",
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        anonymized: { exposure: "passthrough" },
        description: "Read an example.",
        inputSchema: nullAsAbsent(v.looseObject({ query: v.string() })),
        name: "read_example",
        scope: "stella:read",
      }),
    ).toThrow(
      "A native MCP tool input schema must reject unknown root properties",
    );
  });
});

describe("legal AST output identifiers", () => {
  test("canonical identifier outputs publish bounded strings and retain runtime content checks", () => {
    const source = v.strictObject({
      visible: identifierValueSchema,
      searchable: structuredIdentifierValueSchema,
    });
    const contract = defineMcpToolOutput(source);
    expect(contract.outputSchema).toMatchObject({
      properties: {
        visible: { type: "string", maxLength: DECISION_IDENTIFIER_MAX_LENGTH },
        searchable: {
          type: "string",
          maxLength: DECISION_IDENTIFIER_MAX_LENGTH,
        },
      },
    });
    expect(
      v.safeParse(contract.outputSchemaSource, {
        visible: "48 Cdo 1/2026",
        searchable: "ECLI:CZ:NS:2026:1",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(contract.outputSchemaSource, {
        visible: "\u200B",
        searchable: "...",
      }).success,
    ).toBe(false);
    expect(() =>
      defineMcpToolOutput(
        v.strictObject({
          value: v.pipe(
            v.string(),
            v.check(() => false),
          ),
        }),
      ),
    ).toThrow('The "check" action cannot be converted to JSON Schema.');
  });
  test("full recursive AST block output schemas compile without accepting arbitrary checks", () => {
    expect(() =>
      defineMcpToolOutput(v.strictObject({ blocks: v.array(blockSchema) })),
    ).not.toThrow();
  });
});
