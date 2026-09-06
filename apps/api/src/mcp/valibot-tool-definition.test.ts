import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import * as v from "valibot";

import { nullAsAbsent } from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";

describe("Valibot-backed MCP tool definitions", () => {
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
      access: "read",
      annotations: { title: "Read example", readOnlyHint: true },
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
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum rows",
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
      access: "write",
      annotations: { title: "Set example", readOnlyHint: false },
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

  test("rejects an unsupported action without an explicit projection waiver", () => {
    expect(() =>
      defineValibotMcpTool({
        access: "read",
        annotations: { title: "Read example", readOnlyHint: true },
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
        access: "read",
        annotations: { title: "Read example", readOnlyHint: true },
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
