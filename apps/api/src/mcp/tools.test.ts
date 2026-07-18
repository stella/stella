import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { env } from "@/api/env";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const anonymizeTextFieldsMock = mock();
const loadAnonymizationGazetteerEntriesMock = mock();
const decryptContentMock = mock();
const captureErrorMock = mock();
const analyticsCaptureMock = mock();
const analyticsFlushMock = mock(async () => undefined);
const getAnalyticsMock = mock(() => ({
  capture: analyticsCaptureMock,
  flush: analyticsFlushMock,
}));
const searchAcrossMattersExecute = mock();
const readContentAcrossMattersExecute = mock();
const readContactExecute = mock();
type MockSearchHit = {
  entityId: string;
  headline?: string | null;
  kind?: string;
  name: string;
  workspaceId: string;
  workspaceName?: string;
};
const searchProviderSearchMock = mock(
  async (input: { limit: number; query: string }) => {
    const result = await searchAcrossMattersExecute(
      {
        limit: input.limit,
        query: input.query,
      },
      {
        messages: [],
        toolCallId: "mcp",
      },
    );
    const hits: MockSearchHit[] =
      typeof result === "object" &&
      result !== null &&
      "hits" in result &&
      Array.isArray(result.hits)
        ? result.hits
        : [];

    return {
      totalCount:
        typeof result === "object" &&
        result !== null &&
        "totalCount" in result &&
        typeof result.totalCount === "number"
          ? result.totalCount
          : hits.length,
      hits: hits.map((hit) => ({
        entityId: hit.entityId,
        workspaceId: hit.workspaceId,
        workspaceName: hit.workspaceName ?? "Matter Alpha",
        title: hit.name,
        kind: hit.kind ?? "document",
        headline: hit.headline ?? null,
      })),
    };
  },
);
const searchDecisionsHandlerMock = mock();
const readDecisionHandlerMock = mock();
const APP_BASE_URL = env.FRONTEND_URL.replace(/\/$/u, "");

type AnonymizationBlacklistEntryInput = {
  canonical: string;
  enabled?: boolean | undefined;
  label: string;
  variants?: string[] | undefined;
};

const normalizeAnonymizationBlacklistEntryMock = ({
  canonical,
  enabled,
  label,
  variants,
}: AnonymizationBlacklistEntryInput) => ({
  canonical: canonical.trim(),
  enabled: enabled ?? true,
  label: label.trim(),
  variants: [...new Set((variants ?? []).map((value) => value.trim()))].filter(
    (value) => value.length > 0,
  ),
});

const normalizeAnonymizationBlacklistEntriesMock = (
  entries: AnonymizationBlacklistEntryInput[],
) => {
  const seenCanonical = new Set<string>();
  const normalized = [];

  for (const entry of entries) {
    const next = normalizeAnonymizationBlacklistEntryMock(entry);
    if (next.canonical.length === 0 || next.label.length === 0) {
      return Result.err({
        status: 400,
        message: "Anonymization blacklist terms cannot be blank",
      });
    }

    const canonicalKey = next.canonical.toLocaleLowerCase();
    if (seenCanonical.has(canonicalKey)) {
      return Result.err({
        status: 400,
        message: "Duplicate anonymization blacklist term",
      });
    }

    seenCanonical.add(canonicalKey);
    normalized.push(next);
  }

  return Result.ok(normalized);
};

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: getAnalyticsMock,
}));

void mock.module("@/api/lib/content-encryption", () => ({
  decryptContent: decryptContentMock,
  encryptContent: mock(),
}));

void mock.module("@/api/lib/search/provider", () => ({
  getSearchProvider: () => ({
    search: searchProviderSearchMock,
  }),
}));

void mock.module("@/api/mcp/anonymization", () => ({
  anonymizeTextFields: anonymizeTextFieldsMock,
}));

void mock.module("@/api/lib/anonymization-blacklist", () => ({
  loadAnonymizationGazetteerEntries: loadAnonymizationGazetteerEntriesMock,
  normalizeAnonymizationBlacklistEntries:
    normalizeAnonymizationBlacklistEntriesMock,
  normalizeAnonymizationBlacklistEntry:
    normalizeAnonymizationBlacklistEntryMock,
}));

void mock.module("@/api/handlers/case-law/decisions/search", () => ({
  searchDecisionsHandler: searchDecisionsHandlerMock,
}));

void mock.module("@/api/handlers/case-law/decisions/read-by-id", () => ({
  readDecisionBySlugHandler: mock(),
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

const {
  getMcpToolDefinition,
  getMcpToolScopeHint,
  handleMcpToolCall,
  listMcpTools,
} = await import("@/api/mcp/tools");
const { caseLawPublicReadDb } =
  await import("@/api/lib/case-law-public-read-db");

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

// The structured error envelope is a JSON `{"error":{code,message,hint?,...}}`
// text content with isError set. Assert both the flag and the parsed shape.
const expectErrorEnvelope = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  expected: {
    code: string;
    message: string;
    hint?: string;
    retryable?: boolean;
  },
) => {
  expect(result.isError).toBe(true);
  expect(parseToolPayload(result)).toEqual({ error: expected });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The parsed `error` object of a structured `{ error: { code, message,
// issues? } }` envelope. Throws if the result is not a structured envelope.
const validationEnvelope = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): Record<string, unknown> => {
  expect(result.isError).toBe(true);
  const payload = parseToolPayload(result);
  if (!isRecord(payload) || !isRecord(payload["error"])) {
    throw new Error("expected a structured error envelope");
  }
  return payload["error"];
};

// Assert a `validation_error` envelope carrying the given human message. The
// structured `issues` are asserted separately in the tests where their
// dot-paths are the point.
const expectValidationMessage = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  message: string,
): void => {
  const error = validationEnvelope(result);
  expect(error["code"]).toBe("validation_error");
  expect(error["message"]).toBe(message);
};

const FEATURE_DISABLED_HINT =
  "This deployment or organization has this feature turned off; it cannot be enabled from the client.";

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
  slug: "stable-official-slug",
  source: {
    adapterKey: "cz-ns",
    allowsDerivedAi: true,
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

type ExtractedContentRow = {
  charCount: number;
  ciphertext: string;
  entityId: string;
  entity: {
    kind: string;
    name: string;
    workspaceId: string;
  };
  iv: string;
  workspaceId: string;
};

type MockEqFilter = {
  eq?: unknown;
};

type MockEntityFindFirstInput = {
  where?: {
    id?: MockEqFilter;
    workspaceId?: MockEqFilter;
  };
};

type MockMcpTransaction = {
  query: {
    entities: {
      findFirst: (input?: MockEntityFindFirstInput) => Promise<{
        kind: string;
        name: string;
        currentVersion: {
          id: string;
          fields: {
            id: string;
            propertyId: string;
            content: { type: string };
          }[];
        } | null;
      } | null>;
    };
    extractedContent: {
      findFirst: () => Promise<ExtractedContentRow | null>;
    };
    fields: {
      findMany: () => Promise<
        {
          content: { type: string };
          id: string;
          propertyId: string;
        }[]
      >;
    };
  };
  select: () => ReturnType<typeof createSelectBuilder>;
};

const createExtractedContentRow = ({
  charCount = 321,
  entityId = "entity_1",
  name = "Share Purchase Agreement",
  workspaceId = "ws_1",
}: {
  charCount?: number;
  entityId?: string;
  name?: string;
  workspaceId?: string;
} = {}): ExtractedContentRow => ({
  charCount,
  ciphertext: "ciphertext",
  entityId,
  entity: {
    kind: "document",
    name,
    workspaceId,
  },
  iv: "iv",
  workspaceId,
});

const createScopedDb = (
  rows: unknown[] = [],
  extractedContentRow: ExtractedContentRow | null = null,
) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(
      async (callback: (tx: MockMcpTransaction) => unknown) =>
        // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
        await callback({
          query: {
            entities: {
              findFirst: async ({ where }: MockEntityFindFirstInput = {}) => {
                if (!extractedContentRow) {
                  return null;
                }

                if (
                  where?.id?.eq !== extractedContentRow.entityId ||
                  where.workspaceId?.eq !== extractedContentRow.workspaceId
                ) {
                  return null;
                }

                return {
                  kind: extractedContentRow.entity.kind,
                  name: extractedContentRow.entity.name,
                  currentVersion: {
                    id: "entity_version_1",
                    fields: [
                      {
                        id: "field_1",
                        propertyId: "property_1",
                        content: { type: "file" },
                      },
                    ],
                  },
                };
              },
            },
            extractedContent: {
              findFirst: async () => extractedContentRow,
            },
            fields: {
              findMany: async () => [
                {
                  content: { type: "file" },
                  id: "field_1",
                  propertyId: "property_1",
                },
              ],
            },
          },
          select: () => createSelectBuilder(rows),
        }),
    ),
  );

const createRecordAuditEventMock = () =>
  asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  );

const createContext = ({
  accessibleWorkspaceIds = ["ws_1"],
  archivedWorkspaceIds = [],
  recordAuditEvent = createRecordAuditEventMock(),
  scopedDb = createScopedDb(),
}: {
  accessibleWorkspaceIds?: string[];
  archivedWorkspaceIds?: string[];
  recordAuditEvent?: AuditRecorder;
  scopedDb?: McpRequestContext["scopedDb"];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: accessibleWorkspaceIds.map((workspaceId) =>
    toSafeId<"workspace">(workspaceId),
  ),
  accessibleWorkspaceIdSet: new Set(accessibleWorkspaceIds),
  accessibleWorkspaceStatusById: new Map(
    accessibleWorkspaceIds.map((workspaceId) => [
      workspaceId,
      archivedWorkspaceIds.includes(workspaceId) ? "archived" : "active",
    ]),
  ),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole: "owner",
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent,
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

describe("OpenAI-compatible MCP tools", () => {
  beforeEach(() => {
    anonymizeTextFieldsMock.mockReset();
    loadAnonymizationGazetteerEntriesMock.mockReset();
    loadAnonymizationGazetteerEntriesMock.mockResolvedValue([]);
    captureErrorMock.mockReset();
    searchAcrossMattersExecute.mockReset();
    searchProviderSearchMock.mockClear();
    readContentAcrossMattersExecute.mockReset();
    readContactExecute.mockReset();
    decryptContentMock.mockReset();
    decryptContentMock.mockResolvedValue("Full document text");
    searchDecisionsHandlerMock.mockReset();
    readDecisionHandlerMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  test("advertises the exact search compatibility input schema", async () => {
    const searchTool = (await listMcpTools(createContext())).find(
      (tool) => tool.name === "search",
    );

    expect(searchTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
          maxLength: 500,
        },
        cursor: {
          type: "string",
          description:
            "Opaque cursor from a previous search call to fetch the next page",
          maxLength: 512,
        },
      },
      required: ["query"],
    });
  });

  test("advertises the case-law search tool with filter support", async () => {
    const searchTool = (await listMcpTools(createContext())).find(
      (tool) => tool.name === "search_case_law",
    );

    expect(searchTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
          maxLength: 500,
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
          maxLength: 128,
        },
        court: {
          type: "string",
          description: "Filter by court name",
          maxLength: 512,
        },
        country: {
          type: "string",
          description: "Filter by country code",
          maxLength: 3,
        },
        language: {
          type: "string",
          description: "Filter by language code",
          maxLength: 8,
        },
        decision_type: {
          type: "string",
          description: "Filter by decision type",
          maxLength: 128,
        },
        source_id: {
          type: "string",
          description: "Filter by source ID",
          maxLength: 36,
        },
        date_from: {
          type: "string",
          description: "Filter decisions from this ISO date (YYYY-MM-DD)",
          maxLength: 10,
        },
        date_to: {
          type: "string",
          description: "Filter decisions up to this ISO date (YYYY-MM-DD)",
          maxLength: 10,
        },
      },
      required: ["query"],
    });
  });

  test("requires search scope for the case-law search tool", async () => {
    expect(
      (await getMcpToolDefinition("search_case_law", createContext()))?.scope,
    ).toBe("stella:search");
  });

  test("hints dynamic tool scopes from names before resolving definitions", () => {
    expect(getMcpToolScopeHint("search_case_law")).toBe("stella:search");
    expect(getMcpToolScopeHint("mcp__registry__lookup")).toBe(
      "stella:external_mcps",
    );
    expect(getMcpToolScopeHint("skill__research")).toBe("stella:skills");
    expect(getMcpToolScopeHint("mcp__registry__lookup", "anonymized")).toBe(
      undefined,
    );
  });

  test("does not resolve dynamic definitions for unprefixed unknown tools", async () => {
    const scopedDb = createScopedDb();

    expect(
      await getMcpToolDefinition(
        "not_a_tool",
        createContext({ scopedDb }),
        "default",
      ),
    ).toBe(undefined);
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("filters listed tools by granted scopes", async () => {
    const scopedDb = createScopedDb();
    const toolNames = (
      await listMcpTools(createContext({ scopedDb }), "default", [
        "stella:read",
      ])
    ).map((tool) => tool.name);

    expect(toolNames).toContain("list_matters");
    expect(toolNames).not.toContain("search_case_law");
    expect(toolNames).not.toContain("set_practice_jurisdictions");
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("lists the projected read surface in anonymized mode", async () => {
    // The anonymized surface is the registry minus excluded (write / dynamic
    // gateway) tools: every read/search/reference tool, in registry order.
    expect(
      (await listMcpTools(createContext(), "anonymized")).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "search",
      "fetch",
      "list_matters",
      "search_across_matters",
      "search_case_law",
      "read_content_across_matters",
      "read_case_law_decision",
      "read_contact",
      "list_templates",
      "list_documents",
      "read_document",
      "list_properties",
      "lookup_business_registry",
      "list_tasks",
      "list_clauses",
      "list_playbooks",
      "list_time_entries",
      "resolve_rate",
      "list_invoices",
      "get_usage",
      "search_legislation",
    ]);
  });

  test("remaps case-law tools to anonymized scopes", async () => {
    expect(
      (
        await getMcpToolDefinition(
          "search_case_law",
          createContext(),
          "anonymized",
        )
      )?.scope,
    ).toBe("stella:search_anonymized");
    expect(
      (
        await getMcpToolDefinition(
          "read_case_law_decision",
          createContext(),
          "anonymized",
        )
      )?.scope,
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
        limit: 8,
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
    const context = createContext({
      scopedDb: createScopedDb(
        [],
        createExtractedContentRow({ name: "Share Purchase Agreement" }),
      ),
    });
    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context,
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "Share Purchase Agreement",
      text: "Full document text",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      nextCursor: null,
      metadata: {
        charCount: "Full document text".length,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("fetch pages long document text via the returned cursor", async () => {
    const longText = "x".repeat(8000) + "y".repeat(1000);
    decryptContentMock.mockResolvedValue(longText);
    const context = createContext({
      scopedDb: createScopedDb([], createExtractedContentRow()),
    });

    const first = asTestRaw<{
      text: string;
      nextCursor: string | null;
      metadata: { charCount: number; truncated: boolean };
    }>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { id: "entity_1" },
          context,
          toolName: "fetch",
        }),
      ),
    );
    expect(first.text).toBe("x".repeat(8000));
    expect(first.metadata.charCount).toBe(9000);
    expect(first.metadata.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = asTestRaw<{
      text: string;
      nextCursor: string | null;
      metadata: { truncated: boolean };
    }>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { id: "entity_1", cursor: first.nextCursor },
          context,
          toolName: "fetch",
        }),
      ),
    );
    expect(second.text).toBe("y".repeat(1000));
    expect(second.metadata.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
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
          languageAlternateCount: 2,
          slug: "stable-official-slug",
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
        source_id: "11111111-1111-4111-8111-111111111111",
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
        sourceId: "11111111-1111-4111-8111-111111111111",
      },
      caseLawPublicReadDb,
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
          appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/cs/stable-official-slug`,
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
          slug: "stable-official-slug",
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
          appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
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

  // A deployment feature flag gates BOTH surfaces of a tagged tool: the
  // advertised list and dispatch. The case-law tools carry FEATURE_PUBLIC_LAW,
  // matching the public-routes gate on their backing corpus. Dev deployments
  // bypass the gate so local work is never blocked. The env object is mutated
  // in place (same approach the rest of this suite uses) and restored in a
  // finally so the flip cannot leak into a neighbouring test.
  const withPublicLaw = async (
    { featurePublicLaw, isDev }: { featurePublicLaw: boolean; isDev: boolean },
    run: () => Promise<void>,
  ) => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    const previousIsDev = env.isDev;
    env.FEATURE_PUBLIC_LAW = featurePublicLaw;
    env.isDev = isDev;
    try {
      await run();
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      env.isDev = previousIsDev;
    }
  };

  test("hides feature-gated tools from the list when the flag is off outside dev", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      const toolNames = (await listMcpTools(createContext())).map(
        (tool) => tool.name,
      );

      expect(toolNames).not.toContain("search_case_law");
      expect(toolNames).not.toContain("read_case_law_decision");
      // Untagged tools stay listed: the gate only drops flagged tools.
      expect(toolNames).toContain("list_matters");
    });
  });

  test("lists feature-gated tools once the flag is on", async () => {
    await withPublicLaw({ featurePublicLaw: true, isDev: false }, async () => {
      const toolNames = (await listMcpTools(createContext())).map(
        (tool) => tool.name,
      );

      expect(toolNames).toContain("search_case_law");
      expect(toolNames).toContain("read_case_law_decision");
    });
  });

  test("lists feature-gated tools in dev even when the flag is off", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: true }, async () => {
      const toolNames = (await listMcpTools(createContext())).map(
        (tool) => tool.name,
      );

      expect(toolNames).toContain("search_case_law");
      expect(toolNames).toContain("read_case_law_decision");
    });
  });

  test("rejects dispatch of a feature-gated tool when the flag is off outside dev", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      const result = await handleMcpToolCall({
        args: { query: "shareholder dispute" },
        context: createContext(),
        toolName: "search_case_law",
      });

      expectErrorEnvelope(result, {
        code: "feature_disabled",
        message: "This feature is not enabled on this deployment",
        hint: FEATURE_DISABLED_HINT,
      });
      // The gate short-circuits before the backing handler runs, so guessing
      // the tool name cannot reach the corpus.
      expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
    });
  });

  test("dispatches a feature-gated tool once the flag is on", async () => {
    await withPublicLaw({ featurePublicLaw: true, isDev: false }, async () => {
      searchDecisionsHandlerMock.mockResolvedValue({
        facets: { country: [{ count: 1, value: "CZE" }] },
        hits: [
          {
            caseNumber: "29 Cdo 123/2024",
            citationCount: 7,
            country: "CZE",
            court: "Nejvyšší soud",
            decisionDate: "2024-02-01",
            decisionId: "dec_123",
            decisionType: "judgment",
            ecli: null,
            headline: null,
            language: "cs",
            slug: "stable-official-slug",
            sourceUrl: "https://example.test/decision",
          },
        ],
        nextCursor: null,
        totalCount: 1,
      });

      const result = await handleMcpToolCall({
        args: { query: "shareholder dispute" },
        context: createContext(),
        toolName: "search_case_law",
      });

      // The gate opened: the backing handler ran instead of the not-enabled
      // rejection, which would short-circuit before any handler call. With the
      // flag on, app URLs resolve just as in dev.
      expect(searchDecisionsHandlerMock).toHaveBeenCalledTimes(1);
      expect(parseToolPayload(result)).toMatchObject({
        results: [
          {
            appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
            decisionId: "dec_123",
          },
        ],
        totalCount: 1,
      });
    });
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

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "Invalid parameter: date_from. Expected an ISO date in YYYY-MM-DD format",
    );
    expect(error["issues"]).toEqual([
      {
        path: "date_from",
        message:
          "Invalid parameter: date_from. Expected an ISO date in YYYY-MM-DD format",
      },
    ]);
    expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
  });

  test("search_case_law rejects invalid source IDs", async () => {
    const result = await handleMcpToolCall({
      args: {
        query: "shareholder dispute",
        source_id: "not-a-uuid",
      },
      context: createContext(),
      toolName: "search_case_law",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "Invalid parameter: source_id. Expected a UUID",
    );
    expect(error["issues"]).toEqual([
      {
        path: "source_id",
        message: "Invalid parameter: source_id. Expected a UUID",
      },
    ]);
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
      caseLawPublicReadDb,
    );

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      decision: {
        appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
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
          allowsDerivedAi: true,
          id: "src_1",
          name: "Nejvyšší soud",
        },
        sourceUrl: "https://example.test/decision",
        text: "29 Cdo 123/2024\n\nThe court dismissed the appeal.",
        charCount: "29 Cdo 123/2024\n\nThe court dismissed the appeal.".length,
        truncated: false,
      },
    });
  });

  test("read_case_law_decision withholds text when the source bars AI use", async () => {
    const base = createReadDecisionResult();
    readDecisionHandlerMock.mockResolvedValue({
      ...base,
      source: { ...base.source, allowsDerivedAi: false },
    });

    const result = await handleMcpToolCall({
      args: { decision_id: "dec_123" },
      context: createContext(),
      toolName: "read_case_law_decision",
    });

    expect(parseToolPayload(result)).toMatchObject({
      decision: {
        text: null,
        textWithheldReason:
          "The source licence does not permit AI use of the full text.",
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
      nextCursor: null,
      decision: {
        appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
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
          allowsDerivedAi: true,
          id: "src_1",
          name: "Nejvyšší soud",
        },
        sourceUrl: "https://example.test/decision",
        text: "29 Cdo 123/2024\n\nThe court dismissed the appeal.",
        charCount: "29 Cdo 123/2024\n\nThe court dismissed the appeal.".length,
        truncated: false,
      },
    });
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("read_case_law_decision pages citation lists via the compound cursor", async () => {
    const base = createReadDecisionResult();
    readDecisionHandlerMock.mockResolvedValue({
      ...base,
      citationsFrom: Array.from({ length: 60 }, (_unused, i) => ({
        citationText: `from-${i}`,
        id: `cf_${i}`,
      })),
      citationsTo: Array.from({ length: 70 }, (_unused, i) => ({
        citationText: `to-${i}`,
        id: `ct_${i}`,
      })),
    });

    type DecisionPage = {
      nextCursor: string | null;
      decision: {
        citationsFrom: { id: string }[];
        citationsFromTotal: number;
        citationsTo: { id: string }[];
        citationsToTotal: number;
      };
    };

    const page1 = asTestRaw<DecisionPage>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { decision_id: "dec_123" },
          context: createContext(),
          toolName: "read_case_law_decision",
        }),
      ),
    );
    expect(page1.decision.citationsFrom).toHaveLength(50);
    expect(page1.decision.citationsFromTotal).toBe(60);
    expect(page1.decision.citationsTo).toHaveLength(50);
    expect(page1.decision.citationsToTotal).toBe(70);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = asTestRaw<DecisionPage>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { decision_id: "dec_123", cursor: page1.nextCursor },
          context: createContext(),
          toolName: "read_case_law_decision",
        }),
      ),
    );
    expect(page2.decision.citationsFrom).toHaveLength(10);
    expect(page2.decision.citationsTo).toHaveLength(20);
    expect(page2.decision.citationsFrom.at(0)?.id).toBe("cf_50");
    expect(page2.decision.citationsTo.at(0)?.id).toBe("ct_50");
    expect(page2.nextCursor).toBeNull();
  });

  test("fetch rejects documents outside the MCP workspace allowlist", async () => {
    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext({
        accessibleWorkspaceIds: ["ws_1"],
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            workspaceId: "ws_2",
          }),
        ),
      }),
      toolName: "fetch",
    });

    expectErrorEnvelope(result, {
      code: "not_found",
      message: "Matter not found or not accessible",
    });
  });

  test("search_across_matters passes the MCP workspace allowlist to search", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [],
      totalCount: 0,
    });

    const context = createContext({
      accessibleWorkspaceIds: ["ws_1", "ws_3"],
    });
    await handleMcpToolCall({
      args: { query: "share purchase" },
      context,
      toolName: "search_across_matters",
    });

    expect(searchProviderSearchMock).toHaveBeenCalledWith({
      limit: 10,
      organizationId: toSafeId<"organization">("org_1"),
      query: "share purchase",
      workspaceIds: [
        toSafeId<"workspace">("ws_1"),
        toSafeId<"workspace">("ws_3"),
      ],
    });
  });

  test("search_across_matters rejects a malformed cursor instead of resetting to page 1", async () => {
    const result = await handleMcpToolCall({
      args: { query: "share purchase", cursor: "not-a-valid-cursor" },
      context: createContext(),
      toolName: "search_across_matters",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(searchProviderSearchMock).not.toHaveBeenCalled();
  });

  test("read_content_across_matters returns content from allowed workspaces", async () => {
    const context = createContext({
      accessibleWorkspaceIds: ["ws_1", "ws_3"],
      scopedDb: createScopedDb([], createExtractedContentRow()),
    });
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1" },
      context,
      toolName: "read_content_across_matters",
    });

    expect(parseToolPayload(result)).toEqual({
      charCount: "Full document text".length,
      entityId: "entity_1",
      kind: "document",
      name: "Share Purchase Agreement",
      text: "Full document text",
      truncated: false,
      nextCursor: null,
      workspaceId: "ws_1",
    });
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
    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: ["John Smith SPA"],
      gazetteerEntries: [],
      organizationId: toSafeId<"organization">("org_1"),
      workspaceId: "ws_1",
    });
    expect(anonymizeInput?.scopedDb).toBeTypeOf("function");
    expect(loadAnonymizationGazetteerEntriesMock).toHaveBeenCalledTimes(1);
  });

  test("search batches anonymized titles by workspace", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          name: "John Smith SPA",
        },
        {
          entityId: "entity_2",
          workspaceId: "ws_1",
          name: "Jane Doe NDA",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 2,
      fields: ["[PERSON_1] SPA", "[PERSON_2] NDA"],
    });

    const result = await handleMcpToolCall({
      args: { query: "agreement" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "entity_1",
            fieldId: "field_1",
            workspaceId: "ws_1",
          },
          {
            entityId: "entity_2",
            fieldId: "field_2",
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
        {
          id: "entity_2",
          title: "[PERSON_2] NDA",
          url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_2&field=field_2`,
        },
      ],
    });
    expect(anonymizeTextFieldsMock).toHaveBeenCalledTimes(1);
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
      fields: ["John Smith SPA", "Jane Doe NDA"],
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
    decryptContentMock.mockResolvedValueOnce("John Smith signed the agreement");
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 2,
      fields: ["[PERSON_1] SPA", "[PERSON_1] signed the agreement"],
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            name: "John Smith SPA",
          }),
        ),
      }),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "[PERSON_1] SPA",
      text: "[PERSON_1] signed the agreement",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      nextCursor: null,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 2,
        charCount: "[PERSON_1] signed the agreement".length,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("fetch preserves empty anonymized output instead of leaking original content", async () => {
    decryptContentMock.mockResolvedValueOnce("John Smith");
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["", ""],
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            charCount: 42,
            name: "John Smith",
          }),
        ),
      }),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "",
      text: "",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      nextCursor: null,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 1,
        charCount: 0,
        source: "stella",
        truncated: false,
        workspaceId: "ws_1",
      },
    });
  });

  test("fetch uses generic placeholders when anonymized fields are unexpectedly missing", async () => {
    decryptContentMock.mockResolvedValueOnce("John Smith");
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [],
    });

    const result = await handleMcpToolCall({
      args: { id: "entity_1" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            charCount: 42,
            name: "John Smith",
          }),
        ),
      }),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "entity_1",
      title: "[REDACTED]",
      text: "[REDACTED]",
      url: `${APP_BASE_URL}/workspaces/ws_1/all/pdf?entity=entity_1&field=field_1`,
      nextCursor: null,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 1,
        charCount: "[REDACTED]".length,
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

    expectErrorEnvelope(result, {
      code: "internal_error",
      message: "Tool execution failed",
      hint: "If this looks like a stella bug, report it with the send_feedback tool.",
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "database timeout" }),
      { source: "mcp", toolName: "search" },
    );
  });

  // Document tools share resolveEntityWorkspace, which confines them to the
  // document/folder kinds list_documents surfaces. An entity ID that names a
  // task/message/link (kinds hidden from list_documents) must be rejected, not
  // acted on, even though the caller can read that workspace.
  const createEntityKindScopedDb = (kind: string) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  name: string;
                  workspaceId: string;
                }>;
              };
            };
          }) => unknown,
        ) =>
          // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
          await callback({
            query: {
              entities: {
                findFirst: async () => ({
                  kind,
                  name: "Weekly sync",
                  workspaceId: "ws_1",
                }),
              },
            },
          }),
      ),
    );

  test("read_document rejects an entity that is not a document or folder", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_task" },
      context: createContext({ scopedDb: createEntityKindScopedDb("task") }),
      toolName: "read_document",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a document or folder entity" }],
      isError: true,
    });
  });

  test("save_document (update branch) rejects an entity that is not a document or folder", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_message", name: "Renamed" },
      context: createContext({ scopedDb: createEntityKindScopedDb("message") }),
      toolName: "save_document",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a document or folder entity" }],
      isError: true,
    });
  });

  // Cross-field shape rules live in the tool schemas (v.partialCheck), so an
  // invalid combination fails at parse time before any workspace/DB access; the
  // partial_check message is surfaced instead of the generic shape hint.

  test("list_documents rejects flat mode combined with parent_id", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1", mode: "flat", parent_id: "entity_folder" },
      context: createContext(),
      toolName: "list_documents",
    });

    expectValidationMessage(result, "parent_id requires mode 'children'");
  });

  test("list_documents surfaces a field-level issue with a dot-path", async () => {
    const result = await handleMcpToolCall({
      // matter_id must be a string; a number fails the field validator, so the
      // envelope carries a structured issue pinpointing the offending field.
      args: { matter_id: 123 },
      context: createContext(),
      toolName: "list_documents",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "matter_id", message: expect.any(String) },
    ]);
  });

  test("read_document rejects compare_with_version_id without version_id", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1", compare_with_version_id: "ver_base" },
      context: createContext(),
      toolName: "read_document",
    });

    expectValidationMessage(
      result,
      "compare_with_version_id requires version_id (the target version)",
    );
  });

  test("save_document (update branch) rejects an empty update", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1" },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(
      result,
      "Provide at least one change: name, parent_id/move_to_root, or version_id with label/description",
    );
  });

  test("save_document (update branch) rejects parent_id together with move_to_root", async () => {
    const result = await handleMcpToolCall({
      args: {
        entity_id: "entity_1",
        move_to_root: true,
        parent_id: "entity_folder",
      },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(
      result,
      "Provide either parent_id or move_to_root, not both",
    );
  });

  test("save_document (update branch) rejects label without version_id", async () => {
    // A rename keeps rule 1 (at least one change) satisfied so the failure
    // isolates the label-requires-version_id rule.
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1", name: "Renamed", label: "Signed copy" },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(result, "label and description require version_id");
  });

  test("save_document rejects matter_id (a create field) alongside entity_id", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1", matter_id: "ws_1", name: "Renamed" },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(
      result,
      "matter_id applies only when creating; omit it when updating a document",
    );
  });

  test("list_matters rejects matter_id combined with a list filter", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1", limit: 10 },
      context: createContext(),
      toolName: "list_matters",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "status, limit, and cursor apply when listing matters; omit matter_id to list",
    );
    expect(error["issues"]).toEqual([
      {
        path: "matter_id",
        message:
          "status, limit, and cursor apply when listing matters; omit matter_id to list",
      },
    ]);
  });

  // read_document's default branch returns the version history. Each version's
  // label/description are tenant-authored, so they must be pushed through the
  // anonymization plan (not left raw) on the anonymized surface.
  type VersionHistoryRow = {
    createdAt: Date;
    description: string | null;
    id: string;
    label: string | null;
    stamp: string | null;
    versionNumber: number;
  };

  const createVersionHistoryScopedDb = (rows: VersionHistoryRow[]) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(async (callback: (tx: unknown) => unknown) => {
        const selectBuilder = {
          from: () => selectBuilder,
          where: () => selectBuilder,
          orderBy: () => selectBuilder,
          limit: () => rows,
        };
        return await callback({
          query: {
            entities: {
              findFirst: async () => ({
                kind: "document",
                name: "Secret Doc for John Smith",
                workspaceId: "ws_1",
                currentVersion: { id: "ver_current", fields: [] },
              }),
            },
            fields: {
              findMany: async () => [],
            },
          },
          select: () => selectBuilder,
        });
      }),
    );

  test("read_document anonymizes version-history labels and descriptions", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[DOC]", "[PERSON_1] draft", "Redacted note"],
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1", include_versions: true },
      context: createContext({
        scopedDb: createVersionHistoryScopedDb([
          {
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            description: "Note authored by John Smith",
            id: "ver_1",
            label: "Draft by John Smith",
            stamp: null,
            versionNumber: 2,
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "read_document",
    });

    // The version label and description reach the redactor as raw text fields;
    // without the fix they would never be enqueued and would leak verbatim.
    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: [
        "Secret Doc for John Smith",
        "Draft by John Smith",
        "Note authored by John Smith",
      ],
      workspaceId: "ws_1",
    });

    expect(parseToolPayload(result)).toMatchObject({
      versions: [
        expect.objectContaining({
          description: "Redacted note",
          label: "[PERSON_1] draft",
        }),
      ],
    });
  });

  // --- Wave 2: matter / contact / task tools ---------------------------

  // save_* tools enforce their create/update shape with v.partialCheck at the
  // schema, so an invalid combination fails before any permission or DB access
  // and surfaces the specific partial_check message.
  test("save_matter rejects a create with no name", async () => {
    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: "save_matter",
    });

    expectValidationMessage(result, "name is required to create a matter");
  });

  // Archived matters stay readable but are read-only through the write tools,
  // mirroring the HTTP validateWorkspaceAccess macro (which 404s a workspace
  // whose status is not "active"). A field edit on an archived matter is
  // rejected before any backing handler runs.
  test("save_matter rejects a write to an archived matter", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1", name: "Renamed" },
      context: createContext({ archivedWorkspaceIds: ["ws_1"] }),
      toolName: "save_matter",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "Matter is archived; unarchive it first" },
      ],
      isError: true,
    });
  });

  // The one write allowed on an archived matter is a pure status:"active" flip
  // (unarchive); it must still go through.
  const createWorkspaceUnarchiveScopedDb = () =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(async (callback: (tx: unknown) => unknown) => {
        const builder = {
          set: () => builder,
          where: () => builder,
          returning: async () => [{ id: "ws_1" }],
        };
        return await callback({ update: () => builder });
      }),
    );

  test("save_matter allows unarchiving an archived matter", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1", status: "active" },
      context: createContext({
        archivedWorkspaceIds: ["ws_1"],
        scopedDb: createWorkspaceUnarchiveScopedDb(),
      }),
      toolName: "save_matter",
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolPayload(result)).toEqual({
      matterId: "ws_1",
      updated: true,
    });
  });

  test("save_contact rejects a create with no type", async () => {
    const result = await handleMcpToolCall({
      args: { display_name: "Acme Corp" },
      context: createContext(),
      toolName: "save_contact",
    });

    expectValidationMessage(result, "type is required to create a contact");
  });

  test("save_task rejects a create with no matter_id", async () => {
    const result = await handleMcpToolCall({
      args: { name: "Draft motion" },
      context: createContext(),
      toolName: "save_task",
    });

    expectValidationMessage(result, "matter_id is required to create a task");
  });

  // list_tasks (detail) and save_task confine themselves to entities of kind
  // "task": a document/folder ID the caller can otherwise access is rejected as
  // wrong-kind, not acted on.
  const createTaskKindScopedDb = (kind: string) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  workspaceId: string;
                }>;
              };
            };
          }) => unknown,
        ) =>
          // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
          await callback({
            query: {
              entities: {
                findFirst: async () => ({ kind, workspaceId: "ws_1" }),
              },
            },
          }),
      ),
    );

  test("list_tasks rejects a task_id that is not a task", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: "entity_doc" },
      context: createContext({ scopedDb: createTaskKindScopedDb("document") }),
      toolName: "list_tasks",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a task entity" }],
      isError: true,
    });
  });

  test("save_task rejects a task_id that is not a task", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: "entity_doc", name: "Renamed" },
      context: createContext({ scopedDb: createTaskKindScopedDb("document") }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a task entity" }],
      isError: true,
    });
  });

  // save_task ignored matter_id on update, so a mismatched pair silently
  // updated a task under the wrong matter. The handler now rejects it.
  test("save_task rejects a task whose matter_id does not match", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: "task_1", matter_id: "ws_2", name: "Renamed" },
      context: createContext({ scopedDb: createTaskKindScopedDb("task") }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "task_id does not belong to matter_id" }],
      isError: true,
    });
  });

  // list_tasks detail resolved by task_id alone, so a task_id paired with a
  // different accessible matter_id leaked a task from the wrong matter. The
  // detail branch now enforces the same pairing check as save_task.
  test("list_tasks detail rejects a task whose matter_id does not match", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: "task_1", matter_id: "ws_2" },
      context: createContext({
        accessibleWorkspaceIds: ["ws_1", "ws_2"],
        scopedDb: createTaskKindScopedDb("task"),
      }),
      toolName: "list_tasks",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "task_id does not belong to matter_id" }],
      isError: true,
    });
  });

  // unlink_link_id is validated against the task up front: a link belonging to
  // a different task in the same matter is rejected before any mutation runs.
  const createUnlinkMismatchScopedDb = () =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  workspaceId: string;
                }>;
              };
              entityLinks: {
                findFirst: () => Promise<{
                  sourceEntityId: string;
                  targetEntityId: string;
                }>;
              };
            };
          }) => unknown,
        ) =>
          // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
          await callback({
            query: {
              entities: {
                findFirst: async () => ({ kind: "task", workspaceId: "ws_1" }),
              },
              entityLinks: {
                findFirst: async () => ({
                  sourceEntityId: "other_task",
                  targetEntityId: "other_doc",
                }),
              },
            },
          }),
      ),
    );

  test("save_task rejects an unlink_link_id that belongs to another task", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: "task_1", unlink_link_id: "link_1" },
      context: createContext({ scopedDb: createUnlinkMismatchScopedDb() }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "unlink_link_id does not belong to this task" },
      ],
      isError: true,
    });
  });

  // link_entity_id is validated up front against every rejection the backing
  // createEntityLinkHandler applies (self-link, duplicate, read-only target),
  // so a field edit bundled with a doomed link cannot half-apply.
  const createLinkRejectionScopedDb = ({
    existingLink = null,
    updateMock,
  }: {
    existingLink?: { id: string } | null;
    updateMock: ReturnType<typeof mock>;
  }) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  readOnly: boolean;
                  workspaceId: string;
                }>;
              };
              entityLinks: {
                findFirst: () => Promise<{ id: string } | null>;
              };
            };
            update: typeof updateMock;
          }) => unknown,
        ) =>
          // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
          await callback({
            query: {
              entities: {
                findFirst: async () => ({
                  kind: "task",
                  readOnly: false,
                  workspaceId: "ws_1",
                }),
              },
              entityLinks: {
                findFirst: async () => existingLink,
              },
            },
            update: updateMock,
          }),
      ),
    );

  test("save_task rejects a field edit combined with a self-link, without applying the edit", async () => {
    const updateMock = mock(() => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }));

    const result = await handleMcpToolCall({
      args: { task_id: "task_1", name: "Renamed", link_entity_id: "task_1" },
      context: createContext({
        scopedDb: createLinkRejectionScopedDb({ updateMock }),
      }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Cannot link an entity to itself" }],
      isError: true,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("save_task rejects a field edit combined with a duplicate link, without applying the edit", async () => {
    const updateMock = mock(() => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }));

    const result = await handleMcpToolCall({
      args: { task_id: "task_1", name: "Renamed", link_entity_id: "task_2" },
      context: createContext({
        scopedDb: createLinkRejectionScopedDb({
          existingLink: { id: "link_existing" },
          updateMock,
        }),
      }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "A link between these entities already exists" },
      ],
      isError: true,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // link_matter_contact accepts contact_id as an unlink selector, but a contact
  // holding several roles maps to several links, so it must ask for the precise
  // workspace_contact_id instead of guessing.
  const createMultiRoleContactScopedDb = () =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              workspaceContacts: {
                findMany: () => Promise<{ id: string }[]>;
              };
            };
          }) => unknown,
        ) =>
          // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
          await callback({
            query: {
              workspaceContacts: {
                findMany: async () => [{ id: "wc_1" }, { id: "wc_2" }],
              },
            },
          }),
      ),
    );

  test("link_matter_contact rejects an ambiguous contact_id unlink", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1", contact_id: "contact_1" },
      context: createContext({ scopedDb: createMultiRoleContactScopedDb() }),
      toolName: "link_matter_contact",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "That contact holds multiple roles on the matter; pass workspace_contact_id to remove one link",
        },
      ],
      isError: true,
    });
  });

  // A scopedDb whose single select builder returns the given rows from
  // `.limit()`. Shared by the list_tasks and list_time_entries anonymized-egress
  // tests, both of which run one `.select().from().where().orderBy().limit()`
  // read through the structured egress pipeline.
  const createSelectListScopedDb = (rows: readonly Record<string, unknown>[]) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(async (callback: (tx: unknown) => unknown) => {
        const builder = {
          from: () => builder,
          where: () => builder,
          orderBy: () => builder,
          limit: () => rows,
        };
        return await callback({ select: () => builder });
      }),
    );

  test("list_tasks anonymizes task names in anonymized mode", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] deposition"],
    });

    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1" },
      context: createContext({
        scopedDb: createSelectListScopedDb([
          {
            createdAt: "2026-01-01T00:00:00.000000",
            id: "task_1",
            name: "John Smith deposition",
            status: "open",
            priority: "high",
            dueDate: "2026-02-01",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "list_tasks",
    });

    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: ["John Smith deposition"],
      workspaceId: "ws_1",
    });

    expect(parseToolPayload(result)).toEqual({
      tasks: [
        {
          id: "task_1",
          name: "[PERSON_1] deposition",
          status: "open",
          priority: "high",
          dueDate: "2026-02-01",
        },
      ],
      nextCursor: null,
    });
  });

  // list_time_entries (list mode) runs through the structured egress pipeline,
  // so in anonymized mode each entry's narrative is redacted under its matter's
  // workspace scope before it leaves Stella. A null userId keeps the user-name
  // lookup from running, so only the narrative is pushed.
  test("list_time_entries anonymizes narratives in anonymized mode", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["Call with [PERSON_1]"],
    });

    const result = await handleMcpToolCall({
      args: { matter_id: "ws_1" },
      context: createContext({
        scopedDb: createSelectListScopedDb([
          {
            id: "te_1",
            entityId: "entity_1",
            userId: null,
            dateWorked: "2026-02-01",
            durationMinutes: 60,
            billedMinutes: 60,
            rateAtEntry: 25_000,
            currency: "EUR",
            narrative: "Call with John Smith",
            invoiceNarrative: null,
            billable: true,
            noCharge: false,
            status: "draft",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "list_time_entries",
    });

    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: ["Call with John Smith"],
      workspaceId: "ws_1",
    });

    expect(parseToolPayload(result)).toEqual({
      entries: [
        {
          id: "te_1",
          entityId: "entity_1",
          userId: null,
          userName: null,
          dateWorked: "2026-02-01",
          durationMinutes: 60,
          billedMinutes: 60,
          rateAtEntry: 25_000,
          currency: "EUR",
          narrative: "Call with [PERSON_1]",
          invoiceNarrative: null,
          billable: true,
          noCharge: false,
          status: "draft",
        },
      ],
      nextCursor: null,
    });
  });

  // save_time_entry merges create and update. An update (time_entry_id present)
  // with no other field is a no-op the caller almost certainly did not intend;
  // the cross-field schema rejects it before touching the database.
  test("save_time_entry rejects an update with no changes", async () => {
    const result = await handleMcpToolCall({
      args: { time_entry_id: "te_1" },
      context: createContext(),
      toolName: "save_time_entry",
    });

    expectValidationMessage(
      result,
      "Provide at least one change to the time entry",
    );
  });

  // Time-and-billing tools carry FEATURE_TIME_BILLING; get_usage carries
  // FEATURE_USAGE. The gate hides a flagged tool from the list and rejects its
  // dispatch when the flag is off outside dev. Both flags are flipped in place
  // and restored in a finally so the change cannot leak into a neighbour.
  const withBillingFlags = async (
    {
      featureTimeBilling,
      featureUsage,
      isDev,
    }: { featureTimeBilling: boolean; featureUsage: boolean; isDev: boolean },
    run: () => Promise<void>,
  ) => {
    const previousTimeBilling = env.FEATURE_TIME_BILLING;
    const previousUsage = env.FEATURE_USAGE;
    const previousIsDev = env.isDev;
    env.FEATURE_TIME_BILLING = featureTimeBilling;
    env.FEATURE_USAGE = featureUsage;
    env.isDev = isDev;
    try {
      await run();
    } finally {
      env.FEATURE_TIME_BILLING = previousTimeBilling;
      env.FEATURE_USAGE = previousUsage;
      env.isDev = previousIsDev;
    }
  };

  test("hides time-and-billing tools when FEATURE_TIME_BILLING is off outside dev", async () => {
    await withBillingFlags(
      { featureTimeBilling: false, featureUsage: true, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );

        expect(toolNames).not.toContain("list_time_entries");
        expect(toolNames).not.toContain("save_time_entry");
        // Untagged tools stay listed.
        expect(toolNames).toContain("list_matters");
      },
    );
  });

  test("lists time-and-billing tools once FEATURE_TIME_BILLING is on", async () => {
    await withBillingFlags(
      { featureTimeBilling: true, featureUsage: true, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );

        expect(toolNames).toContain("list_time_entries");
        expect(toolNames).toContain("save_time_entry");
        expect(toolNames).toContain("delete_time_entry");
      },
    );
  });

  test("rejects dispatch of save_time_entry when FEATURE_TIME_BILLING is off outside dev", async () => {
    await withBillingFlags(
      { featureTimeBilling: false, featureUsage: true, isDev: false },
      async () => {
        const recordAuditEvent = createRecordAuditEventMock();
        const result = await handleMcpToolCall({
          args: {
            matter_id: "ws_1",
            entity_id: "entity_1",
            date_worked: "2026-02-01",
            timezone_id: "Europe/Prague",
            duration_minutes: 60,
            rate_at_entry: 25_000,
            currency: "EUR",
            narrative: "Call with client",
          },
          context: createContext({ recordAuditEvent }),
          toolName: "save_time_entry",
        });

        expectErrorEnvelope(result, {
          code: "feature_disabled",
          message: "This feature is not enabled on this deployment",
          hint: FEATURE_DISABLED_HINT,
        });
        // The gate short-circuits before the backing handler runs, so no audit
        // row is written by guessing the tool name.
        expect(recordAuditEvent).not.toHaveBeenCalled();
      },
    );
  });

  // get_usage is gated by FEATURE_USAGE, independently of FEATURE_TIME_BILLING:
  // with time-billing on but usage off, the billing tools list but get_usage
  // does not, and its dispatch is rejected.
  test("gates get_usage on FEATURE_USAGE independently of FEATURE_TIME_BILLING", async () => {
    await withBillingFlags(
      { featureTimeBilling: true, featureUsage: false, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );
        expect(toolNames).toContain("list_time_entries");
        expect(toolNames).not.toContain("get_usage");

        const result = await handleMcpToolCall({
          args: {},
          context: createContext(),
          toolName: "get_usage",
        });
        expectErrorEnvelope(result, {
          code: "feature_disabled",
          message: "This feature is not enabled on this deployment",
          hint: FEATURE_DISABLED_HINT,
        });
      },
    );

    await withBillingFlags(
      { featureTimeBilling: true, featureUsage: true, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );
        expect(toolNames).toContain("get_usage");
      },
    );
  });

  // --- Destructive-op confirm guardrail --------------------------------

  // A destructiveHint tool (delete_*) is refused before dispatch unless the
  // caller passes confirm: true, so an agent cannot delete without an explicit
  // human-approved confirmation. The gate runs before any DB access.
  test("delete_document refuses to run without confirm: true", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_1" },
      context: createContext(),
      toolName: "delete_document",
    });

    expectErrorEnvelope(result, {
      code: "confirmation_required",
      message:
        "delete_document is an irreversible operation and was called without confirmation",
      hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
    });
  });

  test("delete_document clears the confirm gate when confirm is true", async () => {
    // confirm: true clears the guardrail; the call proceeds to the handler,
    // which 404s the unknown entity — proving the gate no longer short-circuits
    // and that the handler tolerates the extra confirm arg.
    const result = await handleMcpToolCall({
      args: { entity_id: "entity_missing", confirm: true },
      context: createContext(),
      toolName: "delete_document",
    });

    expectErrorEnvelope(result, {
      code: "not_found",
      message: "Document not found or not accessible",
    });
  });

  // A guessed tool name reports unknown_tool rather than a bare string, so an
  // agent can branch on the code.
  test("dispatching an unknown tool returns the unknown_tool envelope", async () => {
    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: "not_a_real_tool",
    });

    expectErrorEnvelope(result, {
      code: "unknown_tool",
      message: "Unknown tool: not_a_real_tool",
      hint: "Call tools/list for the tools available to this session.",
    });
  });
});
