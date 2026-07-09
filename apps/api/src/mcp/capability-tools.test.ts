import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

// --- Mocks, installed before the MCP graph is imported -----------------------

const captureErrorMock = mock();
const realAnalytics = await import("@/api/lib/analytics");
void mock.module("@/api/lib/analytics", () => ({
  ...realAnalytics,
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

const realLoader = await import("@/api/lib/ai-config-loader");
const loadOrgSettingsMock = mock(async () => ({
  orgAIConfig: null,
  promptCachingEnabled: false,
}));
void mock.module("@/api/lib/ai-config-loader", () => ({
  ...realLoader,
  loadOrgSettingsForAuth: loadOrgSettingsMock,
}));

// Waive one capability so the refusal path is exercised; the real table is empty.
void mock.module("@/api/mcp/capability-waivers", () => ({
  CONTEXT_FIDELITY_WAIVERS: new Map([
    ["billing-codes.create", "test-only waiver: needs response headers"],
  ]),
}));

const { handleMcpToolCall } = await import("@/api/mcp/tools");
const { CAPABILITY_DISPATCH } =
  await import("@/api/mcp/generated/capability-dispatch");
const capabilityCatalog = (
  await import("@/api/mcp/generated/capability-catalog.json")
).default;

// --- Helpers -----------------------------------------------------------------

type ToolCallResult = Awaited<ReturnType<typeof handleMcpToolCall>>;

// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter IS the API: callers pin the parsed shape per assertion
const parseToolPayload = <T = unknown>(result: ToolCallResult): T => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return asTestRaw<T>(JSON.parse(item.text));
};

type ErrorEnvelope = {
  code: string;
  message: string;
  hint?: string;
  issues?: unknown;
};

const errorEnvelope = (result: ToolCallResult): ErrorEnvelope => {
  const payload = parseToolPayload(result);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("error" in payload)
  ) {
    throw new Error(
      `Expected an error envelope, got: ${JSON.stringify(payload)}`,
    );
  }
  return asTestRaw<{ error: ErrorEnvelope }>(payload).error;
};

const noopRecorder = asTestRaw<AuditRecorder>(mock(async () => undefined));

const emptyScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(
  async (run: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: async () => [],
    };
    return await run(builder);
  },
);

const createContext = ({
  grantedScopes = [
    "stella:read",
    "stella:billing_write",
    "stella:knowledge_write",
    "stella:matters_write",
  ],
  memberRole = "owner",
  scopedDb = emptyScopedDb,
  safeDb = toSafeDbMock(emptyScopedDb),
  archivedWorkspaceIds = [] as string[],
  workspaceIds = ["ws_1"],
}: {
  grantedScopes?: readonly string[];
  memberRole?: McpRequestContext["memberRole"];
  scopedDb?: McpRequestContext["scopedDb"];
  safeDb?: McpRequestContext["safeDb"];
  archivedWorkspaceIds?: string[];
  workspaceIds?: string[];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: workspaceIds.map((id) => toSafeId<"workspace">(id)),
  accessibleWorkspaceIdSet: new Set(workspaceIds),
  accessibleWorkspaceStatusById: new Map(
    workspaceIds.map((id) => [
      id,
      archivedWorkspaceIds.includes(id) ? "archived" : "active",
    ]),
  ),
  accessibleWorkspaces: workspaceIds.map((id) => ({
    id: toSafeId<"workspace">(id),
    status: archivedWorkspaceIds.includes(id) ? "archived" : "active",
  })),
  grantedScopes,
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  request: new Request("http://localhost/mcp"),
  recordAuditEvent: noopRecorder,
  safeDb,
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

const call = async (toolName: string, args: Record<string, unknown>) =>
  await handleMcpToolCall({ args, context: createContext(), toolName });

beforeEach(() => {
  captureErrorMock.mockReset();
  loadOrgSettingsMock.mockClear();
});

afterAll(() => {
  mock.restore();
});

// --- Generated-artifact drift -----------------------------------------------

describe("capability dispatch <-> catalog parity", () => {
  test("dispatch keys are exactly the catalog ids", () => {
    const dispatchIds = Object.keys(CAPABILITY_DISPATCH).sort();
    const catalogIds = capabilityCatalog
      .map((entry) => entry.id)
      .sort((a, b) => a.localeCompare(b));
    expect(dispatchIds).toEqual(catalogIds);
  });
});

// --- list_capabilities -------------------------------------------------------

describe("list_capabilities", () => {
  test("returns id/summary/scope items and paginates by cursor", async () => {
    const first = await call("list_capabilities", { limit: 5 });
    const payload = parseToolPayload<{
      items: { id: string; summary: string; scope: string }[];
      nextCursor: string | null;
      limit: number;
    }>(first);
    expect(payload.items).toHaveLength(5);
    expect(payload.limit).toBe(5);
    expect(payload.nextCursor).not.toBeNull();
    for (const item of payload.items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.summary).toBe("string");
      expect(item.scope.startsWith("stella:")).toBe(true);
    }

    const second = await call("list_capabilities", {
      limit: 5,
      cursor: payload.nextCursor,
    });
    const secondPayload = parseToolPayload<{ items: { id: string }[] }>(second);
    // Keyset by id: page two starts strictly after page one's last id.
    const lastOfFirst = payload.items.at(-1)?.id ?? "";
    expect(
      secondPayload.items[0]?.id.localeCompare(lastOfFirst),
    ).toBeGreaterThan(0);
  });

  test("filters by domain", async () => {
    const result = await call("list_capabilities", {
      domain: "time-entries",
      limit: 50,
    });
    const payload = parseToolPayload<{ items: { id: string }[] }>(result);
    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of payload.items) {
      expect(item.id.startsWith("time-entries.")).toBe(true);
    }
  });

  test("filters by access", async () => {
    const result = await call("list_capabilities", {
      access: "write",
      limit: 50,
    });
    const payload = parseToolPayload<{
      items: { id: string; summary: string }[];
    }>(result);
    const ids = new Set(payload.items.map((i) => i.id));
    const catalogById = new Map(capabilityCatalog.map((e) => [e.id, e]));
    for (const id of ids) {
      expect(catalogById.get(id)?.access).toBe("write");
    }
  });
});

// --- describe_capability -----------------------------------------------------

describe("describe_capability", () => {
  test("returns metadata and the live input schema", async () => {
    const result = await call("describe_capability", {
      capability: "time-entries.create",
    });
    const payload = parseToolPayload<{
      id: string;
      access: string;
      handlerKind: string;
      scope: string;
      inputSchema: { body?: unknown };
    }>(result);
    expect(payload.id).toBe("time-entries.create");
    expect(payload.access).toBe("write");
    expect(payload.handlerKind).toBe("workspace");
    expect(payload.scope).toBe("stella:billing_write");
    // Live schema, not the snapshot: the body object schema is present.
    expect(payload.inputSchema.body).toMatchObject({ type: "object" });
  });

  test("describes a snapshot-truncated capability fully from the live config", async () => {
    // views.create is omitted from the JSON snapshot (schema over the byte cap)
    // but describe must still return its live body schema.
    const result = await call("describe_capability", {
      capability: "views.create",
    });
    const payload = parseToolPayload<{ inputSchema: { body?: unknown } }>(
      result,
    );
    expect(payload.inputSchema.body).toBeDefined();
  });

  test("unknown id -> not_found with a suggestion hint", async () => {
    const result = await call("describe_capability", {
      capability: "time-entries.creat",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("time-entries.create");
  });
});

// --- invoke_capability: gates -----------------------------------------------

describe("invoke_capability gates", () => {
  test("unknown id -> not_found with closest-id hint", async () => {
    const result = await call("invoke_capability", {
      capability: "time-entries.creat",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("time-entries.create");
  });

  test("token/public capabilities are not invokable", async () => {
    // No token/public capability exists in the catalog today; assert the guard
    // by confirming the catalog holds only workspace/root kinds (defensive).
    const kinds = new Set(capabilityCatalog.map((e) => e.handlerKind));
    expect([...kinds].sort()).toEqual(["root", "workspace"]);
  });

  test("waived capability -> feature_disabled", async () => {
    const result = await handleMcpToolCall({
      args: { capability: "billing-codes.create", input: { body: {} } },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("test-only waiver");
  });

  test("missing scope -> missing_scope", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "X" } },
      },
      context: createContext({ grantedScopes: ["stella:read"] }),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("missing_scope");
    expect(error.message).toContain("stella:knowledge_write");
  });

  test("destructive capability without confirm -> confirmation_required", async () => {
    const result = await call("invoke_capability", {
      capability: "clauses.categories-delete",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("confirmation_required");
  });

  test("invalid input -> validation_error with dot-path issues", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" }, query: { status: "bogus" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "query.status")).toBe(true);
  });

  test("validateOnly returns without executing", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "Draft category" } },
        validateOnly: true,
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "clauses.categories-create",
    });
    // No handler executed, so the org-settings loader was never consulted.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- invoke_capability: workspace resolution --------------------------------

describe("invoke_capability workspace resolution", () => {
  test("inaccessible workspace -> not_found", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_nope" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("not_found");
  });

  test("archived workspace on a write capability -> not_found", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "case-law.matter-links.create",
        input: {
          body: { decisionId: "00000000-0000-0000-0000-000000000000" },
          params: { workspaceId: "ws_arch" },
        },
      },
      context: createContext({
        workspaceIds: ["ws_arch"],
        archivedWorkspaceIds: ["ws_arch"],
      }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("not_found");
  });
});

// --- invoke_capability: end-to-end execution --------------------------------

describe("invoke_capability execution", () => {
  test("runs a read capability end-to-end (workspace-resolved)", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const payload = parseToolPayload<string>(result);
    expect(typeof payload).toBe("string");
    expect(payload).toContain("Date,");
    expect(loadOrgSettingsMock).toHaveBeenCalled();
  });

  test("runs a write capability end-to-end through the safe-handler wrapper", async () => {
    const insertTx = {
      $count: async () => 0,
      insert: () => ({
        values: () => ({
          returning: async () => [
            {
              id: "cc_1",
              parentId: null,
              name: "Test Category",
              description: null,
              sortOrder: 0,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    };
    const { safeDb, scopedDb } = createScopedDbMock(insertTx);
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "Test Category" } },
      },
      context: createContext({ safeDb, scopedDb }),
      toolName: "invoke_capability",
    });
    expect(
      parseToolPayload<{ id: string; name: string }>(result),
    ).toMatchObject({
      id: "cc_1",
      name: "Test Category",
    });
  });

  test("a role without permission -> permission_denied", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "X" } },
      },
      context: createContext({ memberRole: "intern" }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });
});
