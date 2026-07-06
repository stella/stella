import { describe, expect, test } from "bun:test";

import {
  MAX_ENUM,
  MAX_LISTING_BYTES,
  MAX_PROPS,
  MAX_TOOLS,
  validateFetchedToolsList,
} from "./registry-trust.js";

type ToolEntry = Record<string, unknown>;

const validTool = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  name: "list_matters",
  description: "List matters",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  ...over,
});

const body = (tools: readonly unknown[]): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });

describe("validateFetchedToolsList: rule 1 (interpreted, no eval)", () => {
  test("hostile input is walked as data and never throws", () => {
    // A schema carrying keyword-shaped strings is treated as plain data; the
    // interpreted walker neither compiles nor executes any of it.
    const tool = validTool({
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "string", format: "email", pattern: ".*" },
        },
      },
    });
    const result = validateFetchedToolsList(body([tool]));
    expect(result.ok).toBe(true);
  });
});

describe("validateFetchedToolsList: rule 2 (meta-schema)", () => {
  test("a well-formed body validates and carries a sha256 hash", () => {
    const raw = body([validTool()]);
    const result = validateFetchedToolsList(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listings).toHaveLength(1);
      expect(result.listings.at(0)?.name).toBe("list_matters");
      expect(result.toolsListHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("a name longer than 64 chars is rejected", () => {
    const tool = validTool({ name: `a${"b".repeat(64)}` });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("an uppercase name is rejected", () => {
    expect(
      validateFetchedToolsList(body([validTool({ name: "List" })])).ok,
    ).toBe(false);
  });

  test("a name with a leading digit is rejected", () => {
    expect(
      validateFetchedToolsList(body([validTool({ name: "1tool" })])).ok,
    ).toBe(false);
  });

  test("a non-string description is rejected", () => {
    expect(
      validateFetchedToolsList(body([validTool({ description: 7 })])).ok,
    ).toBe(false);
  });

  test("a non-object inputSchema is rejected", () => {
    expect(
      validateFetchedToolsList(body([validTool({ inputSchema: "nope" })])).ok,
    ).toBe(false);
  });

  test("an inputSchema.type other than object is rejected", () => {
    const tool = validTool({
      inputSchema: { type: "array", properties: {} },
    });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("an inputSchema without a properties object is rejected", () => {
    const tool = validTool({ inputSchema: { type: "object" } });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("an unknown annotation key is rejected", () => {
    const tool = validTool({ annotations: { evilHint: true } });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("a non-boolean annotation hint is rejected", () => {
    const tool = validTool({ annotations: { readOnlyHint: "yes" } });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });
});

describe("validateFetchedToolsList: rule 3 (size/depth caps)", () => {
  test("a body larger than MAX_LISTING_BYTES is rejected", () => {
    const huge = validTool({ description: "x".repeat(MAX_LISTING_BYTES + 10) });
    const raw = body([huge]);
    expect(raw.length).toBeGreaterThan(MAX_LISTING_BYTES);
    expect(validateFetchedToolsList(raw).ok).toBe(false);
  });

  test("more than MAX_TOOLS entries is rejected", () => {
    const tools = Array.from({ length: MAX_TOOLS + 1 }, (_unused, index) =>
      validTool({ name: `tool_${index}` }),
    );
    expect(validateFetchedToolsList(body(tools)).ok).toBe(false);
  });

  test("an inputSchema nested beyond MAX_SCHEMA_DEPTH is rejected", () => {
    let nested: Record<string, unknown> = { type: "string" };
    // inputSchema is depth 1; wrap 7 property levels to exceed a depth cap of 6.
    for (let level = 0; level < 7; level += 1) {
      nested = { type: "object", properties: { child: nested } };
    }
    expect(
      validateFetchedToolsList(body([validTool({ inputSchema: nested })])).ok,
    ).toBe(false);
  });

  test("a single inputSchema larger than MAX_TOOL_SCHEMA_BYTES is rejected", () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 90; index += 1) {
      properties[`p_${index}`] = {
        type: "string",
        description: "d".repeat(1000),
      };
    }
    const tool = validTool({ inputSchema: { type: "object", properties } });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("an enum larger than MAX_ENUM is rejected", () => {
    const tool = validTool({
      inputSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: Array.from({ length: MAX_ENUM + 1 }, (_u, i) => `v${i}`),
          },
        },
      },
    });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("a properties object larger than MAX_PROPS is rejected", () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_PROPS; index += 1) {
      properties[`p_${index}`] = { type: "string" };
    }
    const tool = validTool({ inputSchema: { type: "object", properties } });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });
});

describe("validateFetchedToolsList: rule 4 (no executable content)", () => {
  test("a non-JSON body is rejected", () => {
    expect(validateFetchedToolsList("<html>not json</html>").ok).toBe(false);
  });

  test("a $ref with a URI scheme is rejected", () => {
    const tool = validTool({
      inputSchema: {
        type: "object",
        properties: { x: { $ref: "https://evil.example/schema.json" } },
      },
    });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(false);
  });

  test("a local #/ $ref is accepted", () => {
    const tool = validTool({
      inputSchema: {
        type: "object",
        properties: { x: { $ref: "#/definitions/y" } },
      },
    });
    expect(validateFetchedToolsList(body([tool])).ok).toBe(true);
  });
});
