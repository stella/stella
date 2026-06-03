import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { env } from "@/api/env";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const captureErrorMock = mock();
const analyticsCaptureMock = mock();
const analyticsFlushMock = mock(async () => undefined);
const getAnalyticsMock = mock(() => ({
  capture: analyticsCaptureMock,
  flush: analyticsFlushMock,
}));
const searchDecisionsHandlerMock = mock();
const readDecisionHandlerMock = mock();
const APP_BASE_URL = env.FRONTEND_URL.replace(/\/$/u, "");

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: getAnalyticsMock,
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

type PracticeJurisdictionRow = {
  practiceJurisdictions: { countryCode: string; isPrimary: boolean }[];
};

type MattersRow = {
  createdAt: Date;
  id: string;
  lastActivityAt: Date;
  name: string;
  reference: string | null;
  status: string;
};

type ScopedTx = {
  insert: ReturnType<typeof mock>;
  query: {
    organizationSettings: {
      findFirst: () => Promise<PracticeJurisdictionRow | null>;
    };
    workspaces: {
      findMany: () => Promise<MattersRow[]>;
    };
  };
};

type ScopedDbOptions = {
  insert?: ReturnType<typeof mock>;
  matters?: MattersRow[];
  practiceJurisdictions?: { countryCode: string; isPrimary: boolean }[] | null;
};

const createRecordAuditEventMock = () =>
  asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  );

const createScopedDb = ({
  insert = mock(() => ({
    values: () => ({
      onConflictDoUpdate: async () => undefined,
    }),
  })),
  matters = [],
  practiceJurisdictions = [],
}: ScopedDbOptions = {}) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(async (callback: (tx: ScopedTx) => Promise<unknown>) =>
      callback({
        insert,
        query: {
          organizationSettings: {
            findFirst: async () =>
              practiceJurisdictions === null ? null : { practiceJurisdictions },
          },
          workspaces: {
            findMany: async () => matters,
          },
        },
      }),
    ),
  );

const createContext = ({
  memberRole = "owner",
  recordAuditEvent = createRecordAuditEventMock(),
  scopedDb = createScopedDb(),
}: {
  memberRole?: McpRequestContext["memberRole"];
  recordAuditEvent?: AuditRecorder;
  scopedDb?: McpRequestContext["scopedDb"];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
  accessibleWorkspaceIdSet: new Set(["ws_1"]),
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent,
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

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

describe("set_practice_jurisdictions MCP tool", () => {
  beforeEach(() => {
    captureErrorMock.mockReset();
    searchDecisionsHandlerMock.mockReset();
    readDecisionHandlerMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  test("requires the stella:onboarding scope", () => {
    expect(getMcpToolDefinition("set_practice_jurisdictions")?.scope).toBe(
      "stella:onboarding",
    );
  });

  test("is not exposed in anonymized mode", () => {
    expect(listMcpTools("anonymized").map((tool) => tool.name)).not.toContain(
      "set_practice_jurisdictions",
    );
  });

  test("is exposed in default mode", () => {
    expect(listMcpTools().map((tool) => tool.name)).toContain(
      "set_practice_jurisdictions",
    );
  });

  test("upserts practice jurisdictions on the happy path", async () => {
    const insertMock = mock(() => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }));
    const recordAuditEvent = createRecordAuditEventMock();
    const context = createContext({
      recordAuditEvent,
      scopedDb: createScopedDb({
        insert: insertMock,
        practiceJurisdictions: [{ countryCode: "US", isPrimary: true }],
      }),
    });

    const result = await handleMcpToolCall({
      args: {
        jurisdictions: [
          { countryCode: "CZ", isPrimary: true },
          { countryCode: "SK", isPrimary: false },
        ],
      },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolPayload(result)).toEqual({
      practiceJurisdictions: [
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
      ],
    });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "update",
        changes: {
          practiceJurisdictions: {
            new: [
              { countryCode: "CZ", isPrimary: true },
              { countryCode: "SK", isPrimary: false },
            ],
            old: [{ countryCode: "US", isPrimary: true }],
          },
        },
        resourceId: "org_1",
        resourceType: "organization_settings",
      }),
    );
  });

  test("rejects roles without organization settings permission", async () => {
    const insertMock = mock(() => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }));
    const recordAuditEvent = createRecordAuditEventMock();
    const context = createContext({
      memberRole: "member",
      recordAuditEvent,
      scopedDb: createScopedDb({ insert: insertMock }),
    });

    const result = await handleMcpToolCall({
      args: {
        jurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBe(true);
    const item = result.content.at(0);
    expect(item?.type).toBe("text");
    if (item?.type === "text") {
      expect(item.text).toContain("Forbidden");
    }
    expect(insertMock).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test("promotes the first entry to primary when none was flagged", async () => {
    const context = createContext();

    const result = await handleMcpToolCall({
      args: {
        jurisdictions: [
          { countryCode: "CZ", isPrimary: false },
          { countryCode: "SK", isPrimary: false },
        ],
      },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(parseToolPayload(result)).toEqual({
      practiceJurisdictions: [
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
      ],
    });
  });

  test("rejects more than one primary jurisdiction", async () => {
    const context = createContext();

    const result = await handleMcpToolCall({
      args: {
        jurisdictions: [
          { countryCode: "CZ", isPrimary: true },
          { countryCode: "SK", isPrimary: true },
        ],
      },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBe(true);
    const item = result.content.at(0);
    expect(item?.type).toBe("text");
    if (item?.type === "text") {
      expect(item.text).toContain("Only one jurisdiction can be primary");
    }
  });

  test("rejects malformed country codes", async () => {
    const context = createContext();

    const result = await handleMcpToolCall({
      args: {
        jurisdictions: [{ countryCode: "ZZZ", isPrimary: true }],
      },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBe(true);
  });

  test("rejects empty jurisdictions input", async () => {
    const insertMock = mock(() => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }));
    const recordAuditEvent = createRecordAuditEventMock();
    const context = createContext({
      recordAuditEvent,
      scopedDb: createScopedDb({ insert: insertMock }),
    });

    const result = await handleMcpToolCall({
      args: { jurisdictions: [] },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test("rejects input missing the jurisdictions field", async () => {
    const context = createContext();

    const result = await handleMcpToolCall({
      args: {},
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBe(true);
  });

  test("rejects non-array jurisdictions input", async () => {
    const context = createContext();

    const result = await handleMcpToolCall({
      args: { jurisdictions: "CZ" },
      context,
      toolName: "set_practice_jurisdictions",
    });

    expect(result.isError).toBe(true);
  });
});

describe("empty-result onboarding hints", () => {
  beforeEach(() => {
    captureErrorMock.mockReset();
    searchDecisionsHandlerMock.mockReset();
    readDecisionHandlerMock.mockReset();
  });

  test("list_matters appends a hint when empty and jurisdictions are missing", async () => {
    const context = createContext({
      scopedDb: createScopedDb({
        matters: [],
        practiceJurisdictions: [],
      }),
    });

    const result = await handleMcpToolCall({
      args: {},
      context,
      toolName: "list_matters",
    });

    expect(result.content).toHaveLength(2);
    const hint = result.content.at(1);
    expect(hint?.type).toBe("text");
    if (hint?.type === "text") {
      expect(hint.text).toContain("set_practice_jurisdictions");
      expect(hint.text).toContain(APP_BASE_URL);
    }
  });

  test("list_matters does not append a hint when jurisdictions are configured", async () => {
    const context = createContext({
      scopedDb: createScopedDb({
        matters: [],
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      }),
    });

    const result = await handleMcpToolCall({
      args: {},
      context,
      toolName: "list_matters",
    });

    expect(result.content).toHaveLength(1);
  });

  test("list_matters does not append a hint when results are non-empty", async () => {
    const context = createContext({
      scopedDb: createScopedDb({
        matters: [
          {
            createdAt: new Date("2026-01-01T00:00:00Z"),
            id: "ws_1",
            lastActivityAt: new Date("2026-02-01T00:00:00Z"),
            name: "Matter Alpha",
            reference: "M-001",
            status: "active",
          },
        ],
        practiceJurisdictions: [],
      }),
    });

    const result = await handleMcpToolCall({
      args: {},
      context,
      toolName: "list_matters",
    });

    expect(result.content).toHaveLength(1);
  });

  test("search_case_law appends a hint when empty and jurisdictions are missing", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {},
      hits: [],
      nextCursor: null,
      totalCount: 0,
    });

    const context = createContext({
      scopedDb: createScopedDb({
        matters: [],
        practiceJurisdictions: [],
      }),
    });

    const result = await handleMcpToolCall({
      args: { query: "anything" },
      context,
      toolName: "search_case_law",
    });

    expect(result.content).toHaveLength(2);
    const hint = result.content.at(1);
    expect(hint?.type).toBe("text");
    if (hint?.type === "text") {
      expect(hint.text).toContain("set_practice_jurisdictions");
    }
  });

  test("search_case_law does not append a hint when results are non-empty", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {},
      hits: [
        {
          caseNumber: "29 Cdo 123/2024",
          citationCount: 0,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: "dec_1",
          decisionType: "judgment",
          ecli: null,
          headline: "hit",
          language: "cs",
          sourceUrl: "https://example.test",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });

    const context = createContext({
      scopedDb: createScopedDb({
        practiceJurisdictions: [],
      }),
    });

    const result = await handleMcpToolCall({
      args: { query: "shareholder" },
      context,
      toolName: "search_case_law",
    });

    expect(result.content).toHaveLength(1);
  });

  test("search_case_law does not append a hint when jurisdictions are configured", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {},
      hits: [],
      nextCursor: null,
      totalCount: 0,
    });

    const context = createContext({
      scopedDb: createScopedDb({
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      }),
    });

    const result = await handleMcpToolCall({
      args: { query: "shareholder" },
      context,
      toolName: "search_case_law",
    });

    expect(result.content).toHaveLength(1);
  });
});
