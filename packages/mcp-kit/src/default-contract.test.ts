import { expect, test } from "bun:test";

import { jsonSuccess } from "./envelope";
import { createToolSurface } from "./surface";
import type { ToolDefinition } from "./types";

const direct = {
  name: "search",
  summary: "Search records.",
  access: "read",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Query." } },
    required: ["query"],
  },
  direct: {
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Query." } },
      required: ["query"],
    },
  },
  run: async (args: Record<string, unknown>) => jsonSuccess({ args }),
} satisfies ToolDefinition<undefined>;

const lazy = {
  name: "archive",
  summary: "Archive records.",
  access: "write",
  domain: "records",
  exampleInput: { id: "sample" },
  guide: "May be restored.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      limit: { type: "integer", maximum: Number.MAX_SAFE_INTEGER },
    },
    required: ["id"],
  },
  describedSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Record id." } },
    required: ["id"],
  },
  run: async (args: Record<string, unknown>) => jsonSuccess({ args }),
} satisfies ToolDefinition<undefined>;

// Captured from the pre-option surface: these literals pin property order and wire bytes.
test("default discovery and invocation preserve their serialized wire contracts", async () => {
  const surface = createToolSurface({ tools: [direct, lazy] });
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  expect(JSON.stringify(surface.listTools())).toBe(
    JSON.stringify([
      {
        name: "search",
        description: "Search records.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: readOnly,
      },
      {
        name: "list_capabilities",
        description:
          "Browse capabilities by domain and access, with pagination.",
        inputSchema: {
          type: "object",
          properties: {
            domain: { type: "string" },
            access: { type: "string", enum: ["all", "read", "write"] },
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        annotations: readOnly,
      },
      {
        name: "describe_capability",
        description:
          'Compact parameters and an invocation skeleton; detail="full" returns the full schema.',
        inputSchema: {
          type: "object",
          properties: {
            capability: { type: "string" },
            detail: { type: "string", enum: ["compact", "full"] },
          },
          required: ["capability"],
        },
        annotations: readOnly,
      },
      {
        name: "invoke_capability",
        description: "Run a tool by id with its arguments as `input`.",
        inputSchema: {
          type: "object",
          properties: {
            capability: { type: "string" },
            input: { type: "object" },
            validate_only: { type: "boolean" },
          },
          required: ["capability"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
    ]),
  );
  const cases = [
    {
      name: "list_capabilities",
      args: {},
      body: {
        limit: 50,
        items: [
          {
            id: "archive",
            summary: "Archive records.",
            access: "write",
            description: null,
            destructive: true,
          },
        ],
        nextCursor: null,
      },
    },
    {
      name: "describe_capability",
      args: { capability: "archive" },
      body: {
        id: "archive",
        description: "Archive records.",
        access: "write",
        destructive: true,
        parameters: [{ name: "id", type: "string", required: true }],
        omittedParameters: 0,
        example: { capability: "archive", input: { id: "sample" } },
        hint: 'Example is an invocation skeleton. Call describe_capability with detail="full" for constraints, nested fields, and guidance.',
      },
    },
    {
      name: "describe_capability",
      args: { capability: "archive", detail: "full" },
      body: {
        id: "archive",
        description: "Archive records.\nMay be restored.",
        access: "write",
        destructive: true,
        domain: "records",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            limit: { type: "integer", maximum: 9_007_199_254_740_991 },
          },
          required: ["id"],
        },
      },
    },
    {
      name: "search",
      args: { query: "needle" },
      body: { args: { query: "needle" } },
    },
    {
      name: "invoke_capability",
      args: { capability: "archive", input: { id: "a" } },
      body: { result: { args: { id: "a" } } },
    },
    {
      name: "invoke_capability",
      args: { capability: "archive", input: { id: "a" }, validate_only: true },
      body: { result: { status: "arguments_read", capability: "archive" } },
    },
  ];
  for (const { name, args, body } of cases) {
    expect(JSON.stringify(await surface.callTool(name, args, undefined))).toBe(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: false,
      }),
    );
  }
});
