import { toolDefinition } from "@tanstack/ai";
import type { ServerTool } from "@tanstack/ai";
import { describe, expect, mock, test } from "bun:test";

import type { ChatTool } from "@/api/handlers/chat/tools/chat-tool-types";
import { selectAllowedExternalMcpToolDefinitions } from "@/api/handlers/chat/tools/external-mcp-tool-definitions";
import {
  createLazyExternalMcpToolsLoader,
  createStellaMcpToolSource,
} from "@/api/handlers/chat/tools/external-mcp-tools";
import type { LoadedExternalMcpTools } from "@/api/handlers/chat/tools/external-mcp-tools";
import { normalizeExternalMcpToolsForChat } from "@/api/handlers/chat/tools/external-mcp-tools-normalization";

const tool = (name: string): ChatTool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: "object",
    properties: {},
  },
});

const approvalTool = (name: string): ChatTool => ({
  ...tool(name),
  needsApproval: true,
});

describe("external MCP chat tools", () => {
  test("filters by raw MCP tool name before namespacing", () => {
    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: ["lookup"],
      connectorSlug: "ares",
      nullUnionStrategy: "json-schema",
      tools: [tool("lookup"), tool("deleteEverything")],
    });

    expect(normalized.toolNames).toEqual(["lookup"]);
    expect(Object.keys(normalized.tools)).toEqual(["mcp__ares__lookup"]);
  });

  test("marks exposed tools for TanStack lazy discovery without mutating originals", () => {
    const original = approvalTool("search");

    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: null,
      connectorSlug: "public registry",
      nullUnionStrategy: "json-schema",
      tools: [original],
    });

    const exposed = normalized.tools["mcp__public_registry__search"];
    expect(original.name).toBe("search");
    expect(original.lazy).toBeUndefined();
    expect(exposed?.name).toBe("mcp__public_registry__search");
    expect(exposed?.lazy).toBe(true);
    expect(exposed?.needsApproval).toBe(true);
  });

  test("forces an approval step even when the upstream tool does not require it", () => {
    // The normalized tools back the live `mcp` source handed to `chat()`, so a
    // connector whose server omits `needsApproval` must not let the model
    // invoke external tools without an approval step.
    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: null,
      connectorSlug: "registry",
      nullUnionStrategy: "json-schema",
      tools: [tool("lookup")],
    });

    expect(tool("lookup").needsApproval).toBeUndefined();
    expect(normalized.tools["mcp__registry__lookup"]?.needsApproval).toBe(true);
  });

  test("projects raw MCP JSON schemas even when they contain a standard-looking key", () => {
    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: null,
      connectorSlug: "registry",
      nullUnionStrategy: "openapi",
      tools: [
        {
          ...tool("lookup"),
          inputSchema: {
            type: "object",
            "~standard": {},
            propertyNames: { type: "string" },
            properties: {
              mode: { enum: ["auto", null] },
            },
          },
        },
      ],
    });

    expect(normalized.tools["mcp__registry__lookup"]?.inputSchema).toEqual({
      type: "object",
      properties: {
        mode: { enum: ["auto"], nullable: true },
      },
    });
  });

  test("keeps literal-null MCP branches through the JSON Schema validation prepass", () => {
    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: null,
      connectorSlug: "registry",
      nullUnionStrategy: "json-schema",
      tools: [
        {
          ...tool("lookup"),
          inputSchema: {
            anyOf: [{ type: "string", minLength: 1 }, { const: null }],
          },
        },
      ],
    });

    expect(normalized.tools["mcp__registry__lookup"]?.inputSchema).toEqual({
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    });
  });
});

describe("Stella MCP tool source", () => {
  test("satisfies TanStack MCP lifecycle and preserves lazy discovery by default", async () => {
    const source = createStellaMcpToolSource({
      closeClients: async () => {},
      sourceTools: {
        mcp__registry__lookup: serverTool("mcp__registry__lookup"),
      },
    });

    const tools = await source.tools();

    expect(tools).toEqual([
      expect.objectContaining({
        __toolSide: "server",
        lazy: true,
        name: "mcp__registry__lookup",
      }),
    ]);
  });

  test("can return eager tools when TanStack asks for eager MCP discovery", async () => {
    const source = createStellaMcpToolSource({
      closeClients: async () => {},
      sourceTools: {
        mcp__registry__lookup: serverTool("mcp__registry__lookup"),
      },
    });

    const tools = await source.tools({ lazy: false });

    expect(tools).toEqual([expect.not.objectContaining({ lazy: true })]);
  });
});

describe("external MCP typed definitions", () => {
  test("filters explicit TanStack tool definitions by the connector allowlist", () => {
    const lookup = toolDefinition({
      name: "lookup",
      description: "Lookup a record",
      inputSchema: { type: "object", properties: {} },
    });
    const deleteRecord = toolDefinition({
      name: "delete_record",
      description: "Delete a record",
      inputSchema: { type: "object", properties: {} },
    });

    expect(
      selectAllowedExternalMcpToolDefinitions({
        allowedTools: ["lookup"],
        definitions: [lookup, deleteRecord],
      }),
    ).toEqual([lookup]);
  });
});

describe("createLazyExternalMcpToolsLoader", () => {
  const buildLoaded = (
    overrides: Partial<LoadedExternalMcpTools> = {},
  ): LoadedExternalMcpTools => ({
    close: mock(async () => undefined),
    connectors: [],
    source: createStellaMcpToolSource({
      closeClients: async () => undefined,
      sourceTools: {},
    }),
    tools: {},
    ...overrides,
  });

  test("never calls the loader when getExternalMcpTools is never invoked", async () => {
    const load = mock(async () => buildLoaded());
    const loader = createLazyExternalMcpToolsLoader(load);

    // A message that needs neither validation nor streaming to load
    // external tools must not trigger connector discovery at all.
    await loader.closeIfLoaded();

    expect(load).not.toHaveBeenCalled();
  });

  test("loads at most once across concurrent and sequential callers", async () => {
    const load = mock(async () => buildLoaded());
    const loader = createLazyExternalMcpToolsLoader(load);

    const [first, second] = await Promise.all([
      loader.getExternalMcpTools(),
      loader.getExternalMcpTools(),
    ]);
    const third = await loader.getExternalMcpTools();

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first).toBe(third);
  });

  test("closeIfLoaded closes the cached load exactly once", async () => {
    const closeMock = mock(async () => undefined);
    const load = mock(async () => buildLoaded({ close: closeMock }));
    const loader = createLazyExternalMcpToolsLoader(load);

    await loader.getExternalMcpTools();
    await loader.closeIfLoaded();
    await loader.closeIfLoaded();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  test("closeIfLoaded is a no-op and does not rethrow when the load failed", async () => {
    const load = mock(async () => {
      throw new Error("discovery failed");
    });
    const loader = createLazyExternalMcpToolsLoader(load);

    const rejection = await loader.getExternalMcpTools().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "discovery failed",
    );

    // The finally block's cleanup call must not throw a second time on top
    // of the original failure already surfaced to the caller above: a bare
    // await that completes is the assertion (the test fails if it throws).
    await loader.closeIfLoaded();
  });
});

const serverTool = (name: string): ServerTool => ({
  __toolSide: "server",
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: "object",
    properties: {},
  },
  lazy: true,
});
