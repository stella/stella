import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";

const anonymizeTextFieldsMock = mock();
const captureErrorMock = mock();
const identifyMock = mock();
const analyticsCaptureMock = mock();
const analyticsIdentifyMock = mock();
const analyticsFlushMock = mock(async function flushAnalyticsMock() {
  return;
});
const getAnalyticsMock = mock(() => ({
  capture: analyticsCaptureMock,
  identify: analyticsIdentifyMock,
  flush: analyticsFlushMock,
}));
const searchAcrossMattersExecute = mock();
const readContentAcrossMattersExecute = mock();
const readContactExecute = mock();
const readEntityByIdHandlerMock = mock();
const searchDecisionsHandlerMock = mock();
const readDecisionHandlerMock = mock();
const APP_BASE_URL = env.FRONTEND_URL.replace(/\/$/, "");

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  getAnalytics: getAnalyticsMock,
  identify: identifyMock,
}));

void mock.module("@/api/mcp/anonymization", () => ({
  anonymizeTextFields: anonymizeTextFieldsMock,
}));

void mock.module("@/api/handlers/chat/tools/org-tools", () => ({
  createOrgTools: () => ({
    "search-across-matters": {
      execute: searchAcrossMattersExecute,
    },
    "read-content-across-matters": {
      execute: readContentAcrossMattersExecute,
    },
    "read-contact": {
      execute: readContactExecute,
    },
  }),
}));

void mock.module("@/api/handlers/entities/read-by-id", () => ({
  readEntityByIdHandler: readEntityByIdHandlerMock,
}));

void mock.module("@/api/handlers/case-law/decisions/search", () => ({
  searchDecisionsHandler: searchDecisionsHandlerMock,
}));

void mock.module("@/api/handlers/case-law/decisions/read-by-id", () => ({
  readDecisionHandler: readDecisionHandlerMock,
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

const { getMcpToolDefinition, handleMcpToolCall, listMcpTools } =
  await import("@/api/mcp/tools");

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

const createReadDecisionResult = () => ({
  analysis: null,
  caseNumber: "29 Cdo 123/2024",
  citationsFrom: [{ citationText: "29 Odo 1/2001", id: "c_1" }],
  citationsTo: [{ citationText: "31 Cdo 2/2025", id: "c_2" }],
  country: "CZE",
  court: "Nejvyšší soud",
  decisionDate: new Date("2024-02-01T00:00:00.000Z"),
  decisionType: "judgment",
  documentAst: {
    blocks: [
      {
        anchorId: "a-1",
        id: "b-1",
        inlines: [],
        level: 1,
        plainText: "29 Cdo 123/2024",
        type: "heading",
      },
      {
        anchorId: "a-2",
        id: "b-2",
        inlines: [],
        plainText: "The court dismissed the appeal.",
        type: "paragraph",
      },
    ],
    metadata: {
      caseNumber: "29 Cdo 123/2024",
      court: "Nejvyšší soud",
      decisionDate: "2024-02-01",
      decisionType: "judgment",
      ecli: null,
      keywords: [],
      statutes: [],
    },
    source: {
      documentId: "doc-1",
      printUrl: "https://example.test/print",
      system: "test",
      webUrl: "https://example.test/web",
    },
    version: 1,
  },
  documentUrl: "https://example.test/document.pdf",
  ecli: null,
  fulltext: null,
  id: "dec_123",
  language: "cs",
  metadata: { panel: "29 Cdo" },
  source: {
    adapterKey: "cz-ns",
    id: "src_1",
    name: "Nejvyšší soud",
  },
  sourceUrl: "https://example.test/decision",
});

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
    searchDecisionsHandlerMock.mockReset();
    readDecisionHandlerMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
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

  test("advertises the case-law search tool with filter support", () => {
    const searchTool = listMcpTools().find(
      (tool) => tool.name === "search_case_law",
    );

    expect(searchTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        limit: {
          type: "integer",
          description: "Max results to return",
          minimum: 1,
          maximum: 20,
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from a previous search_case_law call",
        },
        court: {
          type: "string",
          description: "Filter by court name",
        },
        country: {
          type: "string",
          description: "Filter by country code",
        },
        language: {
          type: "string",
          description: "Filter by language code",
        },
        decision_type: {
          type: "string",
          description: "Filter by decision type",
        },
        source_id: {
          type: "string",
          description: "Filter by source ID",
        },
        date_from: {
          type: "string",
          description: "Filter decisions from this ISO date (YYYY-MM-DD)",
        },
        date_to: {
          type: "string",
          description: "Filter decisions up to this ISO date (YYYY-MM-DD)",
        },
      },
      required: ["query"],
    });
  });

  test("requires search scope for the case-law search tool", () => {
    expect(getMcpToolDefinition("search_case_law")?.scope).toBe(
      "stella:search",
    );
  });

  test("lists shared case-law tools in anonymized mode", () => {
    expect(listMcpTools("anonymized").map((tool) => tool.name)).toEqual([
      "search",
      "fetch",
      "search_case_law",
      "read_case_law_decision",
    ]);
  });

  test("remaps case-law tools to anonymized scopes", () => {
    expect(getMcpToolDefinition("search_case_law", "anonymized")?.scope).toBe(
      "stella:search_anonymized",
    );
    expect(
      getMcpToolDefinition("read_case_law_decision", "anonymized")?.scope,
    ).toBe("stella:read_anonymized");
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

  test("search_case_law maps filters and returns decision links", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {
        country: [{ count: 1, value: "CZE" }],
        court: [{ count: 1, value: "Nejvyšší soud" }],
        language: [{ count: 1, value: "cs" }],
      },
      hits: [
        {
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: "dec_123",
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          headline: "Relevant <mark>holding</mark>",
          language: "cs",
          sourceUrl: "https://example.test/decision",
        },
      ],
      nextCursor: "cursor_2",
      totalCount: 1,
    });

    const context = createContext();
    const result = await handleMcpToolCall({
      args: {
        country: "CZE",
        court: "Nejvyšší soud",
        date_from: "2024-01-01",
        decision_type: "judgment",
        limit: 5,
        query: "shareholder dispute",
      },
      context,
      toolName: "search_case_law",
    });

    expect(searchDecisionsHandlerMock).toHaveBeenCalledWith(
      {
        country: "CZE",
        court: "Nejvyšší soud",
        dateFrom: "2024-01-01",
        decisionType: "judgment",
        limit: 5,
        query: "shareholder dispute",
      },
      context.scopedDb,
    );

    expect(parseToolPayload(result)).toEqual({
      facets: {
        country: [{ count: 1, value: "CZE" }],
        court: [{ count: 1, value: "Nejvyšší soud" }],
        language: [{ count: 1, value: "cs" }],
      },
      nextCursor: "cursor_2",
      results: [
        {
          appUrl: `${APP_BASE_URL}/knowledge/case/29-cdo-123-2024--dec_123`,
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: "dec_123",
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          language: "cs",
          snippet: "Relevant <mark>holding</mark>",
          sourceUrl: "https://example.test/decision",
        },
      ],
      totalCount: 1,
    });
  });

  test("search_case_law returns the same payload in anonymized mode", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {
        country: [{ count: 1, value: "CZE" }],
      },
      hits: [
        {
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: "dec_123",
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          headline: "Relevant <mark>holding</mark>",
          language: "cs",
          sourceUrl: "https://example.test/decision",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });

    const result = await handleMcpToolCall({
      args: { query: "shareholder dispute" },
      context: createContext(),
      mode: "anonymized",
      toolName: "search_case_law",
    });

    expect(parseToolPayload(result)).toEqual({
      facets: {
        country: [{ count: 1, value: "CZE" }],
      },
      nextCursor: null,
      results: [
        {
          appUrl: `${APP_BASE_URL}/knowledge/case/29-cdo-123-2024--dec_123`,
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: "dec_123",
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          language: "cs",
          snippet: "Relevant <mark>holding</mark>",
          sourceUrl: "https://example.test/decision",
        },
      ],
      totalCount: 1,
    });
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("search_case_law rejects invalid ISO dates", async () => {
    const result = await handleMcpToolCall({
      args: {
        date_from: "2024-02-30",
        query: "shareholder dispute",
      },
      context: createContext(),
      toolName: "search_case_law",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Invalid parameter: date_from. Expected an ISO date in YYYY-MM-DD format",
        },
      ],
      isError: true,
    });
    expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
  });

  test("read_case_law_decision derives plain text from the AST fallback", async () => {
    readDecisionHandlerMock.mockResolvedValue(createReadDecisionResult());

    const context = createContext();
    const result = await handleMcpToolCall({
      args: { decision_id: "dec_123" },
      context,
      toolName: "read_case_law_decision",
    });

    expect(readDecisionHandlerMock).toHaveBeenCalledWith(
      "dec_123",
      context.scopedDb,
    );

    expect(parseToolPayload(result)).toEqual({
      decision: {
        analysis: null,
        appUrl: `${APP_BASE_URL}/knowledge/case/29-cdo-123-2024--dec_123`,
        caseNumber: "29 Cdo 123/2024",
        citationsFrom: [{ citationText: "29 Odo 1/2001", id: "c_1" }],
        citationsFromTotal: 1,
        citationsTo: [{ citationText: "31 Cdo 2/2025", id: "c_2" }],
        citationsToTotal: 1,
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2024-02-01",
        decisionId: "dec_123",
        decisionType: "judgment",
        documentUrl: "https://example.test/document.pdf",
        ecli: null,
        language: "cs",
        metadata: { panel: "29 Cdo" },
        source: {
          adapterKey: "cz-ns",
          id: "src_1",
          name: "Nejvyšší soud",
        },
        sourceUrl: "https://example.test/decision",
        text: "29 Cdo 123/2024\n\nThe court dismissed the appeal.",
      },
    });
  });

  test("read_case_law_decision returns the same payload in anonymized mode", async () => {
    readDecisionHandlerMock.mockResolvedValue(createReadDecisionResult());

    const result = await handleMcpToolCall({
      args: { decision_id: "dec_123" },
      context: createContext(),
      mode: "anonymized",
      toolName: "read_case_law_decision",
    });

    expect(parseToolPayload(result)).toEqual({
      decision: {
        analysis: null,
        appUrl: `${APP_BASE_URL}/knowledge/case/29-cdo-123-2024--dec_123`,
        caseNumber: "29 Cdo 123/2024",
        citationsFrom: [{ citationText: "29 Odo 1/2001", id: "c_1" }],
        citationsFromTotal: 1,
        citationsTo: [{ citationText: "31 Cdo 2/2025", id: "c_2" }],
        citationsToTotal: 1,
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2024-02-01",
        decisionId: "dec_123",
        decisionType: "judgment",
        documentUrl: "https://example.test/document.pdf",
        ecli: null,
        language: "cs",
        metadata: { panel: "29 Cdo" },
        source: {
          adapterKey: "cz-ns",
          id: "src_1",
          name: "Nejvyšší soud",
        },
        sourceUrl: "https://example.test/decision",
        text: "29 Cdo 123/2024\n\nThe court dismissed the appeal.",
      },
    });
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
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
