import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import * as v from "valibot";

import type { McpToolHandler } from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import { nullAsAbsent, toolDataResult } from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineMcpToolOutput,
  defineProjectedMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";

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
        type: {
          anyOf: [
            { enum: ["left"], type: "string" },
            { enum: ["right"], type: "string" },
          ],
        },
        left: { type: "string" },
        right: { type: "number" },
      },
      required: ["type"],
      additionalProperties: false,
    });
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
      access: "read",
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
      access: "read",
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
      access: "write",
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
        access: "read",
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
        access: "read",
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
        access: "read",
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
