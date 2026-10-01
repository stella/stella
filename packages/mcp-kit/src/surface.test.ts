import { describe, expect, test } from "bun:test";

import {
  failure,
  jsonSuccess,
  KIT_INTERNAL_MESSAGE,
  success,
} from "./envelope";
import { advertisedBytes, compactSchema, hoistRepeatedSchemas } from "./schema";
import { CAPABILITY_TOOL_NAMES, createToolSurface } from "./surface";
import type { McpJsonValue, ToolCallResult, ToolDefinition } from "./types";

type Context = { calls: { name: string; args: Record<string, unknown> }[] };

const record =
  (name: string) => async (args: Record<string, unknown>, context: Context) => {
    context.calls.push({ name, args });
    return jsonSuccess({ tool: name, args });
  };

const SEARCH: ToolDefinition<Context> = {
  name: "search",
  summary: "Search.",
  access: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in detail." },
      exact: { type: "boolean", description: "Match case." },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["query"],
  },
  direct: {
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Text." } },
      required: ["query"],
    },
  },
  run: record("search"),
};

const ARCHIVE: ToolDefinition<Context> = {
  name: "archive_item",
  summary: "Archive an item.",
  exampleInput: { id: "a" },
  guide: "Archived items can be restored within 30 days.",
  access: "write",
  domain: "items",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      mode: { type: "string", enum: ["soft", "hard"] },
      force: { type: "boolean" },
    },
    required: ["id"],
  },
  exactProperties: ["force"],
  run: record("archive_item"),
};

const STATS: ToolDefinition<Context> = {
  name: "item_stats",
  summary: "Count items.",
  access: "read",
  domain: "items",
  inputSchema: { type: "object", properties: {} },
  run: async () =>
    failure({ code: "stale", message: "Out of date.", retryable: true }),
};

const THROWS: ToolDefinition<Context> = {
  name: "explode",
  summary: "Throw.",
  access: "read",
  domain: "misc",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    throw new Error("boom");
  },
};

const surface = createToolSurface({ tools: [SEARCH, ARCHIVE, STATS, THROWS] });

const payload = (result: ToolCallResult): Record<string, unknown> => {
  const first = result.content.at(0);
  if (first === undefined) {
    throw new Error("no content");
  }
  const parsed: unknown = JSON.parse(first.text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected an object payload");
  }
  return Object.fromEntries(Object.entries(parsed));
};

const call = async (name: string, args: unknown) => {
  const context: Context = { calls: [] };
  const result = await surface.callTool(name, args, context);
  return { result, body: payload(result), calls: context.calls };
};

describe("listing", () => {
  test("lists direct tools with compact schemas, then the three capability tools", () => {
    const tools = surface.listTools();

    expect(tools.map(({ name }) => name)).toEqual([
      "search",
      CAPABILITY_TOOL_NAMES.list,
      CAPABILITY_TOOL_NAMES.describe,
      CAPABILITY_TOOL_NAMES.invoke,
    ]);
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(JSON.stringify(tools)).not.toContain('"description":"Text."');
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.at(-1)?.annotations.destructiveHint).toBe(true);
    expect(advertisedBytes(tools)).toBe(
      new TextEncoder().encode(JSON.stringify(tools)).length,
    );
  });

  test("a surface with no lazy tools lists no capability tools", () => {
    const only = createToolSurface({ tools: [SEARCH] });
    expect(only.listTools().map(({ name }) => name)).toEqual(["search"]);
  });

  test("refuses duplicate or reserved names", () => {
    expect(() => createToolSurface({ tools: [SEARCH, SEARCH] })).toThrow(
      "taken",
    );
    expect(() =>
      createToolSurface({
        tools: [{ ...STATS, name: CAPABILITY_TOOL_NAMES.invoke }],
      }),
    ).toThrow("taken");
  });

  test("rejects names that cannot be paginated within the discovery budget", () => {
    for (const name of ["", "é".repeat(65)]) {
      expect(() => createToolSurface({ tools: [{ ...STATS, name }] })).toThrow(
        "Tool names must",
      );
    }
  });

  test("rejects metadata that would fail before wire serialization", () => {
    const cyclic: { next: McpJsonValue } = { next: null };
    cyclic.next = cyclic;
    for (const tool of [
      { ...ARCHIVE, exampleInput: { id: 1n } },
      { ...ARCHIVE, exampleInput: cyclic },
      {
        ...ARCHIVE,
        inputSchema: { type: "object", properties: {}, examples: [cyclic] },
      },
      {
        ...ARCHIVE,
        describedSchema: { type: "object", properties: {}, examples: [cyclic] },
      },
    ]) {
      expect(() => createToolSurface({ tools: [tool] })).toThrow(
        "acyclic JSON data",
      );
    }
  });

  test("compactSchema strips annotations at every depth but keeps property names", () => {
    expect(
      compactSchema({
        type: "object",
        description: "x",
        properties: {
          description: {
            type: "string",
            description: "a property named description",
          },
          nested: {
            type: "array",
            items: { type: "object", title: "t", default: {} },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        description: { type: "string" },
        nested: { type: "array", items: { type: "object" } },
      },
    });
  });

  test("hoistRepeatedSchemas states a repeated shape once", () => {
    const shape = {
      type: "object",
      properties: { left: { type: "integer" }, right: { type: "integer" } },
    };
    const hoisted = hoistRepeatedSchemas(
      {
        type: "object",
        properties: { first: shape, second: shape, third: { type: "string" } },
      },
      { minBytes: 40 },
    );

    expect(hoisted).toEqual({
      type: "object",
      properties: {
        first: { $ref: "#/$defs/first" },
        second: { $ref: "#/$defs/first" },
        third: { type: "string" },
      },
      $defs: { first: shape },
    });
    expect(
      hoistRepeatedSchemas({ type: "object", properties: { only: shape } }),
    ).toEqual({
      type: "object",
      properties: { only: shape },
    });
  });

  test("compactSchema keeps descriptions as many property levels deep as asked", () => {
    const schema = {
      type: "object",
      description: "the tool",
      properties: {
        ops: {
          type: "array",
          description: "the operations",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "text to find" },
            },
          },
        },
      },
    };

    expect(compactSchema(schema, { describedDepth: 1 })).toEqual({
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "the operations",
          items: { type: "object", properties: { find: { type: "string" } } },
        },
      },
    });
  });
});

describe("capability tools", () => {
  test("list_capabilities pages the unlisted tools and filters by domain and access", async () => {
    const all = await call(CAPABILITY_TOOL_NAMES.list, {});
    const items = await call(CAPABILITY_TOOL_NAMES.list, {
      domain: "items",
      access: "write",
    });
    const first = await call(CAPABILITY_TOOL_NAMES.list, { limit: 1 });
    const second = await call(CAPABILITY_TOOL_NAMES.list, {
      limit: 1,
      cursor: first.body["nextCursor"],
    });

    expect(all.body).toEqual({
      limit: 50,
      items: [
        {
          id: "archive_item",
          summary: "Archive an item.",
          description: null,
          access: "write",
          destructive: true,
        },
        {
          id: "explode",
          summary: "Throw.",
          description: null,
          access: "read",
          destructive: false,
        },
        {
          id: "item_stats",
          summary: "Count items.",
          description: null,
          access: "read",
          destructive: false,
        },
      ],
      nextCursor: null,
    });
    expect(items.body["items"]).toEqual([
      {
        id: "archive_item",
        summary: "Archive an item.",
        description: null,
        access: "write",
        destructive: true,
      },
    ]);
    expect(second.body["items"]).toEqual([
      {
        id: "explode",
        summary: "Throw.",
        description: null,
        access: "read",
        destructive: false,
      },
    ]);
  });

  test("its own arguments are read strictly", async () => {
    const typo = await call(CAPABILITY_TOOL_NAMES.list, { domian: "items" });
    const stringy = await call(CAPABILITY_TOOL_NAMES.invoke, {
      capability: "archive_item",
      input: { id: "a" },
      validate_only: "true",
    });

    expect(typo.result.isError).toBe(true);
    expect(typo.body).toMatchObject({
      error: {
        code: "validation_error",
        issues: [{ path: "domian" }],
        retryable: true,
      },
    });
    expect(stringy.body).toMatchObject({
      error: { issues: [{ path: "validate_only" }] },
    });
    expect(stringy.calls).toEqual([]);
  });

  test("describe_capability returns the full schema and guidance of any tool", async () => {
    const lazy = await call(CAPABILITY_TOOL_NAMES.describe, {
      capability: "archive_item",
      detail: "full",
    });
    const direct = await call(CAPABILITY_TOOL_NAMES.describe, {
      capability: "search",
      detail: "full",
    });
    const unknown = await call(CAPABILITY_TOOL_NAMES.describe, {
      capability: "archive",
    });

    expect(lazy.body).toEqual({
      id: "archive_item",
      description:
        "Archive an item.\nArchived items can be restored within 30 days.",
      access: "write",
      destructive: true,
      domain: "items",
      inputSchema: ARCHIVE.inputSchema,
    });
    expect(direct.body["inputSchema"]).toEqual(SEARCH.inputSchema);
    expect(unknown.body).toMatchObject({
      error: { code: "not_found", retryable: false },
    });
    expect(unknown.body).toMatchObject({
      error: { hint: expect.stringContaining('"archive_item"') },
    });
  });

  test("describes a large schema compactly by default and preserves the full schema on request", async () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["soft", "hard"] },
        document: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 500 }, (_, index) => [
              `field${index}`,
              {
                type: "string",
                description: "Long nested guidance. ".repeat(10),
              },
            ]),
          ),
        },
        ...Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [
            `argument${index}`,
            { type: "string" },
          ]),
        ),
      },
      required: ["mode"],
    };
    expect(
      new TextEncoder().encode(JSON.stringify(schema)).length,
    ).toBeGreaterThan(33_000);
    const large = createToolSurface({
      tools: [
        { ...ARCHIVE, inputSchema: schema, exampleInput: { mode: "soft" } },
      ],
    });
    const compact = await large.callTool(
      CAPABILITY_TOOL_NAMES.describe,
      { capability: ARCHIVE.name },
      { calls: [] },
    );
    const explicit = await large.callTool(
      CAPABILITY_TOOL_NAMES.describe,
      { capability: ARCHIVE.name, detail: "compact" },
      { calls: [] },
    );
    const full = await large.callTool(
      CAPABILITY_TOOL_NAMES.describe,
      { capability: ARCHIVE.name, detail: "full" },
      { calls: [] },
    );
    expect(compact).toEqual(explicit);
    expect(
      new TextEncoder().encode(compact.content.at(0)?.text).length,
    ).toBeLessThan(3000);
    expect(payload(compact)).toMatchObject({
      description: ARCHIVE.summary,
      parameters: expect.arrayContaining([
        {
          name: "mode",
          type: "string",
          required: true,
          enum: ["soft", "hard"],
        },
        { name: "document", type: "object", required: false },
      ]),
      example: { capability: ARCHIVE.name, input: { mode: "soft" } },
    });
    expect(payload(compact)["omittedParameters"]).toBeGreaterThan(0);
    expect(payload(compact)["inputSchema"]).toBeUndefined();
    expect(payload(full)["inputSchema"]).toEqual(schema);
  });

  test("bounds compact descriptions with escaped Unicode metadata and oversized examples", async () => {
    for (const { name, summary } of [
      { name: "\u0000".repeat(128), summary: "\u0000".repeat(1000) },
      { name: "📄".repeat(32), summary: `a${"\u0301".repeat(4000)}` },
      { name: "graphemes", summary: `${"a".repeat(119)}👨‍👩‍👧‍👦z` },
    ]) {
      const tool = {
        ...ARCHIVE,
        name,
        summary,
        exampleInput: { id: "é".repeat(4000) },
        inputSchema: {
          type: "object",
          properties: {
            ["é".repeat(4000)]: { type: "string", enum: ["📄".repeat(4000)] },
          },
        },
      };
      const bounded = createToolSurface({ tools: [tool] });
      const result = await bounded.callTool(
        CAPABILITY_TOOL_NAMES.describe,
        { capability: name },
        { calls: [] },
      );
      expect(
        new TextEncoder().encode(result.content.at(0)?.text).length,
      ).toBeLessThan(3000);
      expect(payload(result)).toMatchObject({
        example: { capability: name, input: {} },
        omittedParameters: 1,
      });
      if (name === "graphemes") {
        expect(payload(result)["description"]).toBe(`${"a".repeat(119)}👨‍👩‍👧‍👦`);
      }
    }
  });

  test("advertised discovery stays constant as the hidden registry grows", () => {
    const many = createToolSurface({
      tools: Array.from({ length: 1000 }, (_, index) => ({
        ...ARCHIVE,
        name: `items.archive${index}`,
      })),
    });
    const one = createToolSurface({ tools: [ARCHIVE] });
    expect(many.listTools()).toEqual(one.listTools());
  });

  test("portable cursors round-trip Unicode names and reject malformed encodings", async () => {
    const names = ["a.čtení", "b.保存", "c.📄"];
    const unicode = createToolSurface({
      tools: names.map((name) => ({ ...STATS, name })),
    });
    let cursor: unknown;
    for (const name of names) {
      const page = payload(
        await unicode.callTool(
          CAPABILITY_TOOL_NAMES.list,
          { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
          { calls: [] },
        ),
      );
      expect(page["items"]).toMatchObject([{ id: name }]);
      cursor = page["nextCursor"];
    }
    expect(cursor).toBeNull();
    for (const malformed of ["!", "a", "_w", "YW=="]) {
      const result = await unicode.callTool(
        CAPABILITY_TOOL_NAMES.list,
        { cursor: malformed },
        { calls: [] },
      );
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({
        error: { code: "validation_error" },
      });
    }
  });

  test("invoke_capability runs a tool with its input, or only validates it", async () => {
    const ran = await call(CAPABILITY_TOOL_NAMES.invoke, {
      capability: "archive_item",
      input: { id: "a", mode: "HARD" },
    });
    const checked = await call(CAPABILITY_TOOL_NAMES.invoke, {
      capability: "archive_item",
      input: { id: "a" },
      validate_only: true,
    });

    expect(ran.calls).toEqual([
      { name: "archive_item", args: { id: "a", mode: "hard" } },
    ]);
    expect(ran.result.content.at(1)?.text).toBe(
      'Input read: Read "HARD" as "hard".',
    );
    expect(checked.body).toEqual({
      result: {
        status: "arguments_read",
        capability: "archive_item",
      },
    });
    expect(ran.body).toEqual({
      result: { tool: "archive_item", args: { id: "a", mode: "hard" } },
    });
    expect(checked.calls).toEqual([]);
  });
});

describe("calling a tool", () => {
  test("reads arguments leniently and says how", async () => {
    const { body, calls, result } = await call("search", {
      query: "x",
      exact: "yes",
      limit: "5",
      unusedOptional: undefined,
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      { name: "search", args: { query: "x", exact: true, limit: 5 } },
    ]);
    expect(body).toEqual({
      tool: "search",
      args: { query: "x", exact: true, limit: 5 },
    });
    expect(result.content.at(1)?.text).toContain('Read "yes" as true.');
  });

  test("drops null optionals, and keeps exact properties exactly as sent", async () => {
    const { calls } = await call("archive_item", {
      id: "a",
      mode: null,
      force: "true",
    });

    expect(calls).toEqual([
      { name: "archive_item", args: { id: "a", force: "true" } },
    ]);
  });

  test("refuses unknown and missing arguments without running", async () => {
    const unknown = await call("search", { query: "x", qeury: "y" });
    const missing = await call("archive_item", {});
    const ambiguous = await call("search", { query: "x", exact: "perhaps" });

    for (const outcome of [unknown, missing, ambiguous]) {
      expect(outcome.result.isError).toBe(true);
      expect(outcome.calls).toEqual([]);
    }
    expect(unknown.body).toMatchObject({
      error: {
        code: "validation_error",
        issues: [{ path: "qeury", message: "Unknown parameter: qeury" }],
        hint: "Accepted parameters: query, exact, limit.",
      },
    });
    expect(missing.body).toMatchObject({ error: { issues: [{ path: "id" }] } });
    expect(ambiguous.body).toMatchObject({
      error: { issues: [{ path: "exact" }] },
    });
  });

  test("rejects inherited property names as undeclared arguments", async () => {
    for (const key of ["toString", "constructor", "__proto__"]) {
      const result = await call(
        "search",
        JSON.parse(`{"query":"x","${key}":"y"}`),
      );
      expect(result.calls).toEqual([]);
      expect(result.body).toMatchObject({
        error: { code: "validation_error", issues: [{ path: key }] },
      });
      const meta = await call(
        CAPABILITY_TOOL_NAMES.list,
        JSON.parse(`{"${key}":"y"}`),
      );
      expect(meta.body).toMatchObject({
        error: { code: "validation_error", issues: [{ path: key }] },
      });
    }
  });

  test("a tool's own failure and a throw both come back in the one envelope", async () => {
    const stale = await call("item_stats", {});
    const thrown = await call("explode", {});

    expect(stale.body).toEqual({
      error: { code: "stale", message: "Out of date.", retryable: true },
    });
    expect(thrown.body).toEqual({
      error: {
        code: "internal_error",
        message: KIT_INTERNAL_MESSAGE,
        retryable: false,
      },
    });
    expect(thrown.result.isError).toBe(true);
  });

  test("redacts every handler rejection and preserves its cause for host telemetry", async () => {
    for (const cause of [
      new Error("private SQL /path/to/file"),
      { privateMatter: "content" },
      "private provider response",
    ]) {
      const observations: { cause: unknown; event: unknown }[] = [];
      const rejection = Promise.withResolvers();
      const rejected = createToolSurface({
        tools: [
          { ...THROWS, run: async () => jsonSuccess(await rejection.promise) },
        ],
        onError: (error, event) => {
          observations.push({ cause: error, event });
        },
      });
      rejection.reject(cause);
      for (const name of [THROWS.name, CAPABILITY_TOOL_NAMES.invoke]) {
        const result = await rejected.callTool(
          name,
          name === THROWS.name ? {} : { capability: THROWS.name },
          { calls: [] },
        );
        expect(payload(result)).toEqual({
          error: {
            code: "internal_error",
            message: KIT_INTERNAL_MESSAGE,
            retryable: false,
          },
        });
        expect(result.isError).toBe(true);
      }
      expect(observations).toEqual([
        { cause, event: { tool: THROWS.name, phase: "handler" } },
        { cause, event: { tool: THROWS.name, phase: "handler" } },
      ]);
    }
  });

  test("reports serialization failures to host telemetry for both invocation paths", async () => {
    const cyclic: { next: McpJsonValue } = { next: null };
    cyclic.next = cyclic;
    const observations: unknown[] = [];
    const broken = createToolSurface({
      tools: [{ ...THROWS, run: async () => success(cyclic) }],
      onError: (cause, event) => {
        observations.push({ cause, event });
      },
    });
    for (const name of [THROWS.name, CAPABILITY_TOOL_NAMES.invoke]) {
      const result = await broken.callTool(
        name,
        name === THROWS.name ? {} : { capability: THROWS.name },
        { calls: [] },
      );
      expect(payload(result)).toEqual({
        error: {
          code: "internal_error",
          message: KIT_INTERNAL_MESSAGE,
          retryable: false,
        },
      });
    }
    expect(observations).toMatchObject([
      {
        cause: expect.any(Error),
        event: { tool: THROWS.name, phase: "serialization" },
      },
      {
        cause: expect.any(Error),
        event: { tool: THROWS.name, phase: "serialization" },
      },
    ]);
  });

  test("rejects composed argument roots during registration", () => {
    for (const keyword of ["$ref", "allOf", "anyOf", "oneOf"]) {
      expect(() =>
        createToolSurface({
          tools: [{ ...STATS, inputSchema: { type: "object", [keyword]: [] } }],
        }),
      ).toThrow(`root ${keyword}`);
    }
  });

  test("dry runs describe argument reading without claiming schema validity", async () => {
    const constrained = createToolSurface({
      tools: [
        {
          ...SEARCH,
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", pattern: "^[a-z]{10}$" } },
            required: ["query"],
          },
        },
      ],
    });
    const context: Context = { calls: [] };
    const result = payload(
      await constrained.callTool(
        CAPABILITY_TOOL_NAMES.invoke,
        { capability: SEARCH.name, input: { query: "x" }, validate_only: true },
        context,
      ),
    );
    expect(result).toEqual({
      result: { capability: SEARCH.name, status: "arguments_read" },
    });
    expect(context.calls).toEqual([]);
  });

  test("keeps unbounded guides out of paged discovery", async () => {
    const guide = "Detailed guidance. ".repeat(5000);
    const guided = createToolSurface({ tools: [{ ...ARCHIVE, guide }] });
    const listed = await guided.callTool(
      CAPABILITY_TOOL_NAMES.list,
      {},
      { calls: [] },
    );
    const described = await guided.callTool(
      CAPABILITY_TOOL_NAMES.describe,
      { capability: ARCHIVE.name, detail: "full" },
      { calls: [] },
    );
    expect(JSON.stringify(payload(listed))).not.toContain(guide);
    expect(payload(described)).toMatchObject({
      description: `${ARCHIVE.summary}\n${guide}`,
    });
  });

  test("an unknown tool suggests the close names", async () => {
    const { body } = await call("serach", {});

    expect(body).toMatchObject({ error: { code: "unknown_tool" } });
    expect(body).toMatchObject({
      error: { hint: expect.stringContaining('"search"') },
    });
  });
});
