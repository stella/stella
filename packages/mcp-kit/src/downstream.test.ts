import { describe, expect, test } from "bun:test";

import { failure, jsonSuccess, KIT_INTERNAL_MESSAGE } from "./envelope";
import { advertisedBytes, compactSchema, hoistRepeatedSchemas } from "./schema";
import { CAPABILITY_TOOL_NAMES, createToolSurface } from "./surface";
import type { McpJsonSchema, ToolCallResult, ToolDefinition } from "./types";

const DOWNSTREAM_OPTIONS = {
  discovery: { type: "outline" },
  fullSchema: "described",
  capabilityResult: "payload",
  validationResult: "input",
  capabilityList: "minimal",
  metaDescriptions: "enumerated",
} as const;

type Context = { calls: { name: string; args: Record<string, unknown> }[] };

const record =
  (name: string) => (args: Record<string, unknown>, context: Context) => {
    context.calls.push({ name, args });
    return Promise.resolve(jsonSuccess({ tool: name, args }));
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
  run: () =>
    Promise.resolve(
      failure({ code: "stale", message: "Out of date.", retryable: true }),
    ),
};

const THROWS: ToolDefinition<Context> = {
  name: "explode",
  summary: "Throw.",
  access: "read",
  domain: "misc",
  inputSchema: { type: "object", properties: {} },
  run: () => Promise.reject(new Error("boom")),
};

const surface = createToolSurface({
  ...DOWNSTREAM_OPTIONS,
  tools: [SEARCH, ARCHIVE, STATS, THROWS],
});

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

const errorHint = (body: Record<string, unknown>): string => {
  const error = body["error"];
  if (
    typeof error !== "object" ||
    error === null ||
    !("hint" in error) ||
    typeof error.hint !== "string"
  ) {
    throw new Error("Expected an error hint");
  }
  return error.hint;
};

const call = async (name: string, args: unknown) => {
  const context: Context = { calls: [] };
  const result = await surface.callTool(name, args, context);
  return { result, body: payload(result), calls: context.calls };
};

describe("downstream listing", () => {
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
    const only = createToolSurface({ ...DOWNSTREAM_OPTIONS, tools: [SEARCH] });
    expect(only.listTools().map(({ name }) => name)).toEqual(["search"]);
  });

  test("refuses duplicate or reserved names", () => {
    expect(() =>
      createToolSurface({ ...DOWNSTREAM_OPTIONS, tools: [SEARCH, SEARCH] }),
    ).toThrow("taken");
    expect(() =>
      createToolSurface({
        ...DOWNSTREAM_OPTIONS,
        tools: [{ ...STATS, name: CAPABILITY_TOOL_NAMES.invoke }],
      }),
    ).toThrow("taken");
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

  test("compactSchema omits a safe-integer maximum only when explicitly requested", () => {
    expect(
      compactSchema(
        { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        { omitMaxSafeInteger: true },
      ),
    ).toEqual({ type: "integer", minimum: 0 });
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

describe("downstream capability tools", () => {
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
      items: [
        {
          id: "archive_item",
          summary: "Archive an item.",
          access: "write",
          destructive: true,
        },
        { id: "explode", summary: "Throw.", access: "read" },
        { id: "item_stats", summary: "Count items.", access: "read" },
      ],
      nextCursor: null,
    });
    expect(items.body["items"]).toEqual([
      {
        id: "archive_item",
        summary: "Archive an item.",
        access: "write",
        destructive: true,
      },
    ]);
    expect(second.body["items"]).toEqual([
      { id: "explode", summary: "Throw.", access: "read" },
    ]);
  });

  test("pages ids in one ordinal order, whatever their case, digits or underscores", async () => {
    const names = ["b_tool", "B2", "a10", "a9", "A_x", "item", "Item_2", "_z"];
    const mixed = createToolSurface({
      ...DOWNSTREAM_OPTIONS,
      tools: names.map((name) => ({ ...STATS, name })),
    });
    const seen: string[] = [];
    let cursor: unknown;
    for (let page = 0; page <= names.length; page += 1) {
      const result = await mixed.callTool(
        CAPABILITY_TOOL_NAMES.list,
        { limit: 3, ...(typeof cursor === "string" && { cursor }) },
        { calls: [] },
      );
      const body = payload(result);
      const items = body["items"];
      if (!Array.isArray(items)) {
        throw new TypeError("Expected capability items");
      }
      for (const item of items) {
        if (
          typeof item !== "object" ||
          item === null ||
          !("id" in item) ||
          typeof item.id !== "string"
        ) {
          throw new Error("Expected a capability id");
        }
        seen.push(item.id);
      }
      cursor = body["nextCursor"];
      if (cursor === null) {
        break;
      }
    }

    expect(seen).toEqual(names.toSorted());
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

  test("describe_capability outlines any tool, and gives its full schema on request", async () => {
    const compact = await call(CAPABILITY_TOOL_NAMES.describe, {
      capability: "archive_item",
    });
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
    const badDetail = await call(CAPABILITY_TOOL_NAMES.describe, {
      capability: "search",
      detail: "everything",
    });

    expect(compact.body).toEqual({
      id: "archive_item",
      description: "Archive an item.",
      access: "write",
      destructive: true,
      parameters: {
        id: "string (required)",
        mode: '"soft" | "hard"',
        force: "boolean",
      },
      more: 'detail: "full" returns the full input schema.',
    });
    expect(lazy.body).toEqual({
      id: "archive_item",
      description:
        "Archive an item.\nArchived items can be restored within 30 days.",
      access: "write",
      destructive: true,
      inputSchema: ARCHIVE.inputSchema,
    });
    expect(direct.body["inputSchema"]).toEqual(SEARCH.inputSchema);
    expect(badDetail.body).toMatchObject({
      error: { issues: [{ path: "detail" }] },
    });
    expect(unknown.body).toMatchObject({
      error: { code: "not_found", retryable: false },
    });
    expect(errorHint(unknown.body)).toContain('"archive_item"');
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
    expect(checked.body).toEqual({ valid: true, input: { id: "a" } });
    expect(checked.calls).toEqual([]);
  });
});

describe("downstream tool calls", () => {
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

  test("refuses inherited names such as toString and __proto__ as parameters", async () => {
    // JSON.parse makes `__proto__` an own key, as a client's arguments would.
    const args: unknown = JSON.parse(
      '{"query":"x","toString":"y","__proto__":{"polluted":true}}',
    );
    const tool = await call("search", args);
    const meta = await call(
      CAPABILITY_TOOL_NAMES.describe,
      JSON.parse(
        '{"capability":"search","__proto__":{"detail":"full"},"constructor":1}',
      ),
    );

    expect(tool.result.isError).toBe(true);
    expect(tool.body).toMatchObject({
      error: { issues: [{ path: "toString" }, { path: "__proto__" }] },
    });
    expect(tool.calls).toEqual([]);
    expect(meta.body).toMatchObject({
      error: { issues: [{ path: "__proto__" }, { path: "constructor" }] },
    });
    expect(Object.hasOwn({}, "polluted")).toBe(false);
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

  test("an unknown tool suggests the close names", async () => {
    const { body } = await call("serach", {});

    expect(body).toMatchObject({ error: { code: "unknown_tool" } });
    expect(errorHint(body)).toContain('"search"');
  });
});

test("downstream discovery publishes guidance, bare examples and recursive type outlines", async () => {
  const describedSchema = {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      nullable: { type: ["string", "null"] },
      variant: {
        oneOf: [{ type: "string" }, { type: "integer" }, { type: "string" }],
      },
      freeform: {},
    },
    required: ["ids"],
  } satisfies McpJsonSchema;
  const configured = createToolSurface({
    ...DOWNSTREAM_OPTIONS,
    tools: [
      {
        ...ARCHIVE,
        brief: "Use a stable id.",
        exampleInput: { ids: ["a"] },
        inputSchema: describedSchema,
        describedSchema,
      },
    ],
  });
  expect(
    payload(
      await configured.callTool(
        CAPABILITY_TOOL_NAMES.describe,
        { capability: "archive_item" },
        { calls: [] },
      ),
    ),
  ).toEqual({
    id: "archive_item",
    description: "Archive an item.\nUse a stable id.",
    access: "write",
    destructive: true,
    parameters: {
      ids: "string[] (required)",
      nullable: "string | null",
      variant: "string | integer",
      freeform: "any",
    },
    example: { ids: ["a"] },
    more: 'detail: "full" returns the full input schema.',
  });
  expect(configured.listTools().map(({ description }) => description)).toEqual([
    "List tools not shown here (archive_item).",
    'Parameters, guidance and an example for any tool, by id; detail: "full" for the whole schema.',
    "Run a tool by id with its arguments as `input`.",
  ]);
  const invoked = payload(
    await configured.callTool(
      CAPABILITY_TOOL_NAMES.invoke,
      { capability: "archive_item", input: { ids: ["a"] } },
      { calls: [] },
    ),
  );
  expect(invoked).toEqual({ tool: "archive_item", args: { ids: ["a"] } });
});

test("downstream full discovery returns the described schema with repeated shapes hoisted", async () => {
  const shape = {
    type: "object",
    properties: {
      identifier: {
        type: "string",
        description:
          "A stable record identifier retained across edits and independent of display labels.",
      },
      revision: {
        type: "integer",
        description:
          "The revision to which the requested operation applies, starting at zero.",
      },
    },
    required: ["identifier", "revision"],
  };
  const configured = createToolSurface({
    ...DOWNSTREAM_OPTIONS,
    tools: [
      {
        ...ARCHIVE,
        describedSchema: hoistRepeatedSchemas({
          type: "object",
          properties: { first: shape, second: shape },
        }),
      },
    ],
  });
  expect(
    payload(
      await configured.callTool(
        CAPABILITY_TOOL_NAMES.describe,
        { capability: "archive_item", detail: "full" },
        { calls: [] },
      ),
    ),
  ).toEqual({
    id: "archive_item",
    description:
      "Archive an item.\nArchived items can be restored within 30 days.",
    access: "write",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        first: { $ref: "#/$defs/first" },
        second: { $ref: "#/$defs/first" },
      },
      $defs: { first: shape },
    },
  });
});

test("schema compaction options omit advertising bounds and dialects only at schema positions", () => {
  const instance = {
    maximum: Number.MAX_SAFE_INTEGER,
    $schema: "instance dialect",
  };
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    maximum: Number.MAX_SAFE_INTEGER,
    anyOf: [
      {
        type: "integer",
        maximum: Number.MAX_SAFE_INTEGER,
        $schema: "variant dialect",
      },
    ],
    $defs: {
      amount: {
        type: "integer",
        maximum: Number.MAX_SAFE_INTEGER,
        $schema: "definition dialect",
      },
    },
    properties: {
      maximum: { type: "integer", maximum: Number.MAX_SAFE_INTEGER },
      $schema: { type: "string" },
      bounded: { type: "integer", maximum: 10 },
      nested: {
        type: "array",
        items: {
          type: "integer",
          maximum: Number.MAX_SAFE_INTEGER,
          $schema: "nested dialect",
        },
      },
      literal: { const: instance, enum: [instance], "x-instance": instance },
    },
  } satisfies McpJsonSchema;
  expect(compactSchema(schema)).toEqual(schema);
  expect(
    compactSchema(schema, { omitMaxSafeInteger: true, schemaDialect: "omit" }),
  ).toEqual({
    type: "object",
    anyOf: [{ type: "integer" }],
    $defs: { amount: { type: "integer" } },
    properties: {
      maximum: { type: "integer" },
      $schema: { type: "string" },
      bounded: { type: "integer", maximum: 10 },
      nested: { type: "array", items: { type: "integer" } },
      literal: { const: instance, enum: [instance], "x-instance": instance },
    },
  });
  expect(schema.properties.maximum.maximum).toBe(Number.MAX_SAFE_INTEGER);
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
});

test("described full schemas and payload invocation are independent of discovery and validation modes", async () => {
  const describedSchema = {
    type: "object",
    properties: {
      display: { type: "string", description: "For discovery only." },
    },
  };
  const configured = createToolSurface({
    tools: [{ ...ARCHIVE, describedSchema }],
    fullSchema: "described",
    capabilityResult: "payload",
  });
  expect(
    payload(
      await configured.callTool(
        CAPABILITY_TOOL_NAMES.describe,
        { capability: "archive_item", detail: "full" },
        { calls: [] },
      ),
    ),
  ).toEqual({
    id: "archive_item",
    description:
      "Archive an item.\nArchived items can be restored within 30 days.",
    access: "write",
    destructive: true,
    domain: "items",
    inputSchema: describedSchema,
  });
  expect(
    payload(
      await configured.callTool(
        CAPABILITY_TOOL_NAMES.invoke,
        { capability: "archive_item", input: { id: "a" } },
        { calls: [] },
      ),
    ),
  ).toEqual({ tool: "archive_item", args: { id: "a" } });
  expect(
    payload(
      await configured.callTool(
        CAPABILITY_TOOL_NAMES.invoke,
        { capability: "archive_item", input: { id: "a" }, validate_only: true },
        { calls: [] },
      ),
    ),
  ).toEqual({
    result: { status: "arguments_read", capability: "archive_item" },
  });
  const context: Context = { calls: [] };
  const invalid = await configured.callTool(
    CAPABILITY_TOOL_NAMES.invoke,
    { capability: "archive_item", input: { display: "name" } },
    context,
  );
  expect(invalid.isError).toBe(true);
  expect(context.calls).toEqual([]);
});

test("bounded discovery includes supplied short guidance while retaining its budget", async () => {
  const configured = createToolSurface({
    tools: [{ ...ARCHIVE, brief: "Use a stable id." }],
  });
  const result = await configured.callTool(
    CAPABILITY_TOOL_NAMES.describe,
    { capability: "archive_item" },
    { calls: [] },
  );
  expect(payload(result)["description"]).toBe(
    "Archive an item.\nUse a stable id.",
  );
  const large = createToolSurface({
    tools: [{ ...ARCHIVE, brief: "guidance ".repeat(1000) }],
  });
  const bounded = await large.callTool(
    CAPABILITY_TOOL_NAMES.describe,
    { capability: "archive_item" },
    { calls: [] },
  );
  expect(
    new TextEncoder().encode(bounded.content.at(0)?.text).length,
  ).toBeLessThan(2900);
});

test.each([1.5, "1.5", -2.5, "-2.5"])(
  "argument preview rejects fractional integer spelling %s",
  async (maxBlocks) => {
    const configured = createToolSurface({
      ...DOWNSTREAM_OPTIONS,
      tools: [
        {
          ...SEARCH,
          inputSchema: {
            type: "object",
            properties: {
              maxBlocks: { type: "integer", minimum: 1, maximum: 1000 },
            },
          },
        },
      ],
    });
    const context: Context = { calls: [] };
    const result = await configured.callTool(
      CAPABILITY_TOOL_NAMES.invoke,
      { capability: "search", input: { maxBlocks }, validate_only: true },
      context,
    );
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: { code: "validation_error", issues: [{ path: "maxBlocks" }] },
    });
    expect(context.calls).toEqual([]);
  },
);
