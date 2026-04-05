import { beforeEach, describe, expect, mock, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";

const anonymizeTextFieldsMock = mock();
const captureErrorMock = mock();
const identifyMock = mock();
const searchAcrossMattersExecute = mock();
const readContentAcrossMattersExecute = mock();
const readContactExecute = mock();
const readEntityByIdHandlerMock = mock();
const APP_BASE_URL = env.FRONTEND_URL.replace(/\/$/, "");

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  identify: identifyMock,
}));

void mock.module("@/api/mcp/anonymization", () => ({
  anonymizeTextFields: anonymizeTextFieldsMock,
}));

void mock.module("@/api/handlers/registry/actors/chat-tools", () => ({
  createOrgTools: () => ({
    searchAcrossMatters: {
      execute: searchAcrossMattersExecute,
    },
    readContentAcrossMatters: {
      execute: readContentAcrossMattersExecute,
    },
    readContact: {
      execute: readContactExecute,
    },
  }),
}));

void mock.module("@/api/handlers/entities/read-by-id", () => ({
  readEntityByIdHandler: readEntityByIdHandlerMock,
}));

void mock.module("@/api/handlers/workspaces/read-by-id", () => ({
  readWorkspaceHandler: mock(),
}));

void mock.module("@/api/handlers/workspaces/read-overview", () => ({
  readOverviewHandler: mock(),
}));

void mock.module("@/api/handlers/workspaces/workspace-contacts-read", () => ({
  readWorkspaceContactsHandler: mock(),
}));

const { handleMcpToolCall, listMcpTools } = await import("@/api/mcp/tools");

const parseToolPayload = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
) => {
  const item = result.content.at(0);
  expect(item?.type).toBe("text");

  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }

  return JSON.parse(item.text) as unknown;
};

const createSelectBuilder = (rows: unknown[]) => {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    leftJoin: () => builder,
    where: () => rows,
  };

  return builder;
};

const createScopedDb = (rows: unknown[] = []) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only implements the query shape used by getFetchableEntityMap
  mock(
    async (
      callback: (tx: {
        select: () => ReturnType<typeof createSelectBuilder>;
      }) => unknown,
    ) =>
      await callback({
        select: () => createSelectBuilder(rows),
      }),
  ) as unknown as McpRequestContext["scopedDb"] & ReturnType<typeof mock>;

const createContext = ({
  accessibleWorkspaceIds = ["ws_1"],
  scopedDb = createScopedDb(),
}: {
  accessibleWorkspaceIds?: string[];
  scopedDb?: McpRequestContext["scopedDb"];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: accessibleWorkspaceIds.map((workspaceId) =>
    toSafeId<"workspace">(workspaceId),
  ),
  accessibleWorkspaceIdSet: new Set(accessibleWorkspaceIds),
  memberRole: "owner",
  organizationId: toSafeId<"organization">("org_1"),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

describe("OpenAI-compatible MCP tools", () => {
  beforeEach(() => {
    anonymizeTextFieldsMock.mockReset();
    captureErrorMock.mockReset();
    identifyMock.mockReset();
    searchAcrossMattersExecute.mockReset();
    readContentAcrossMattersExecute.mockReset();
    readContactExecute.mockReset();
    readEntityByIdHandlerMock.mockReset();
  });

  test("advertises the exact search compatibility input schema", () => {
    const searchTool = listMcpTools().find((tool) => tool.name === "search");

    expect(searchTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    });
  });

  test("lists only search and fetch for anonymized mode", () => {
    expect(listMcpTools("anonymized").map((tool) => tool.name)).toEqual([
      "search",
      "fetch",
    ]);
  });

  test("returns only fetchable documents with canonical document URLs", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          name: "Share Purchase Agreement",
        },
        {
          entityId: "entity_2",
          workspaceId: "ws_2",
          name: "Not Fetchable",
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: { query: "share purchase" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "entity_1",
            fieldId: "field_1",
            workspaceId: "ws_1",
          },
        ]),
      }),
      toolName: "search",
    });

    expect(searchAcrossMattersExecute).toHaveBeenCalledWith(
      {
        limit: 16,
        query: "share purchase",
      },
      {
        messages: [],
        toolCallId: "mcp",
      },
    );

    expect(parseToolPayload(result)).toEqual({
      results: [
        {
          id: "entity_1",
          title: "Share Purchase Agreement",
          url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
        },
      ],
    });
  });

  test("fetch returns document text with citation metadata", async () => {
    readContentAcrossMattersExecute.mockResolvedValue({
      charCount: 321,
      name: "Share Purchase Agreement",
      text: "Full document text",
      truncated: false,
      workspaceId: "ws_1",
    });
    readEntityByIdHandlerMock.mockResolvedValue({
      entityId: "entity_1",
      fields: [
        {
          id: "field_1",
          content: {
            type: "file",
          },
        },
      ],
      kind: "document",
      name: "Share Purchase Agreement",
    });

    const context = createContext();
    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context,
      toolName: "fetch",
    });

    expect(readEntityByIdHandlerMock).toHaveBeenCalledWith({
      entityId: "entity_1",
      scopedDb: context.scopedDb,
      workspaceId: "ws_1",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "Share Purchase Agreement",
      text: "Full document text",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      metadata: {
        charCount: 321,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("fetch rejects documents outside the MCP workspace allowlist", async () => {
    readContentAcrossMattersExecute.mockResolvedValue({
      name: "Share Purchase Agreement",
      text: "Full document text",
      truncated: false,
      workspaceId: "ws_2",
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext({
        accessibleWorkspaceIds: ["ws_1"],
      }),
      toolName: "fetch",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Matter not found or not accessible",
      },
    ]);
    expect(readEntityByIdHandlerMock).not.toHaveBeenCalled();
  });

  test("search anonymizes titles in anonymized mode", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          name: "John Smith SPA",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] SPA"],
    });

    const result = await handleMcpToolCall({
      args: { query: "john smith" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "entity_1",
            fieldId: "field_1",
            workspaceId: "ws_1",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      results: [
        {
          id: "entity_1",
          title: "[PERSON_1] SPA",
          url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
        },
      ],
    });
    expect(anonymizeTextFieldsMock).toHaveBeenCalledWith({
      fields: ["John Smith SPA"],
      workspaceId: "ws_1",
    });
  });

  test("search preserves empty anonymized output instead of leaking the original title", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          name: "John Smith",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [""],
    });

    const result = await handleMcpToolCall({
      args: { query: "john smith" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "entity_1",
            fieldId: "field_1",
            workspaceId: "ws_1",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      results: [
        {
          id: "entity_1",
          title: "",
          url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
        },
      ],
    });
  });

  test("search uses a generic placeholder when anonymized fields are unexpectedly missing", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          name: "John Smith",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [],
    });

    const result = await handleMcpToolCall({
      args: { query: "john smith" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "entity_1",
            fieldId: "field_1",
            workspaceId: "ws_1",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      results: [
        {
          id: "entity_1",
          title: "[REDACTED]",
          url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
        },
      ],
    });
  });

  test("fetch anonymizes title and text in anonymized mode", async () => {
    readContentAcrossMattersExecute.mockResolvedValue({
      charCount: 321,
      name: "John Smith SPA",
      text: "John Smith signed the agreement",
      truncated: false,
      workspaceId: "ws_1",
    });
    readEntityByIdHandlerMock.mockResolvedValue({
      entityId: "entity_1",
      fields: [
        {
          id: "field_1",
          content: {
            type: "file",
          },
        },
      ],
      kind: "document",
      name: "John Smith SPA",
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 2,
      fields: ["[PERSON_1] SPA", "[PERSON_1] signed the agreement"],
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext(),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "[PERSON_1] SPA",
      text: "[PERSON_1] signed the agreement",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 2,
        charCount: 321,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("fetch preserves empty anonymized output instead of leaking original content", async () => {
    readContentAcrossMattersExecute.mockResolvedValue({
      charCount: 42,
      name: "John Smith",
      text: "John Smith",
      truncated: false,
      workspaceId: "ws_1",
    });
    readEntityByIdHandlerMock.mockResolvedValue({
      entityId: "entity_1",
      fields: [
        {
          id: "field_1",
          content: {
            type: "file",
          },
        },
      ],
      kind: "document",
      name: "John Smith",
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["", ""],
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext(),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "",
      text: "",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 1,
        charCount: 42,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("fetch uses generic placeholders when anonymized fields are unexpectedly missing", async () => {
    readContentAcrossMattersExecute.mockResolvedValue({
      charCount: 42,
      name: "John Smith",
      text: "John Smith",
      truncated: false,
      workspaceId: "ws_1",
    });
    readEntityByIdHandlerMock.mockResolvedValue({
      entityId: "entity_1",
      fields: [
        {
          id: "field_1",
          content: {
            type: "file",
          },
        },
      ],
      kind: "document",
      name: "John Smith",
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [],
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext(),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "[REDACTED]",
      text: "[REDACTED]",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 1,
        charCount: 42,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("tool failures return a generic MCP error and capture the original exception", async () => {
    searchAcrossMattersExecute.mockRejectedValue(new Error("database timeout"));

    const result = await handleMcpToolCall({
      args: { query: "share purchase" },
      context: createContext(),
      toolName: "search",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Tool execution failed",
        },
      ],
      isError: true,
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "database timeout" }),
      { source: "mcp", toolName: "search" },
    );
  });
});
