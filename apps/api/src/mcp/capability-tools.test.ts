import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { runWithRequestId } from "@/api/lib/observability/request-context";
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

// Stub the gateway rate limit so execution tests are not throttled; a single
// test flips it to exhausted to assert the rate_limited envelope. Restored by
// afterAll(mock.restore).
const consumeRateLimitMock = mock(async () => ({
  ok: true,
  retryAfterSeconds: 60,
}));
void mock.module("@/api/mcp/capability-rate-limit", () => ({
  consumeInvokeCapabilityRateLimit: consumeRateLimitMock,
}));

// Controllable feature gate: the real module short-circuits on the dev test
// env, so the deployment-gate tests toggle flags through this set instead
// (cleared in beforeEach). Default (empty set) behaves like everything-enabled.
const disabledFeatures = new Set<string>();
const realCapabilityFeature = await import("@/api/mcp/capability-feature");
void mock.module("@/api/mcp/capability-feature", () => ({
  ...realCapabilityFeature,
  isCapabilityFeatureEnabled: (feature: string | undefined) =>
    feature === undefined || !disabledFeatures.has(feature),
}));

const { handleMcpToolCall } = await import("@/api/mcp/tools");
const { mapHandlerResult } = await import("@/api/mcp/capability-tools");
const { ElysiaCustomStatusResponse } = await import("elysia");
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
  consumeRateLimitMock.mockClear();
  consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSeconds: 60 });
  disabledFeatures.clear();
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

  test("chat capabilities carry the dedicated stella:chat scope", () => {
    const chatEntries = capabilityCatalog.filter((entry) =>
      entry.id.startsWith("chat."),
    );
    expect(chatEntries.length).toBeGreaterThan(0);
    for (const entry of chatEntries) {
      expect(entry.scope, entry.id).toBe("stella:chat");
    }
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

  test("archived workspace on a READ capability -> not_found (REST parity)", async () => {
    // validateWorkspaceAccess (lib/auth.ts) 404s ANY non-active workspace,
    // reads included; the generic path must be no weaker.
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_arch" } },
      },
      context: createContext({
        workspaceIds: ["ws_arch"],
        archivedWorkspaceIds: ["ws_arch"],
      }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("not_found");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
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

// --- fix-2: route-level admin gate moved into the handler config -------------

describe("case-law ingestion status admin gate (fix-2)", () => {
  test("a non-admin member -> permission_denied (gate now in the handler)", async () => {
    // The admin/owner gate moved from a route onBeforeHandle into the handler
    // config (auditLog: ["read"], held only by owner/admin), so the generic
    // invoke path enforces it too.
    const result = await handleMcpToolCall({
      args: { capability: "case-law.ingestion.status" },
      context: createContext({ memberRole: "member" }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });
});

// --- validateOnly enforces member permissions --------------------------------

describe("invoke_capability validateOnly permission preflight", () => {
  test("a role lacking the permission -> permission_denied from validateOnly", async () => {
    // case-law.ingestion.status is root-kind with auditLog:["read"] (owner/
    // admin only); validateOnly must mirror the wrapper's gate, not report
    // valid: true for a call that would 403 at execution.
    const result = await handleMcpToolCall({
      args: { capability: "case-law.ingestion.status", validateOnly: true },
      context: createContext({ memberRole: "member" }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
    // Preflight only: the handler never executed.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("a sufficient role still gets valid: true without executing", async () => {
    const result = await handleMcpToolCall({
      args: { capability: "case-law.ingestion.status", validateOnly: true },
      context: createContext({ memberRole: "owner" }),
      toolName: "invoke_capability",
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({ valid: true, capability: "case-law.ingestion.status" });
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- fix-3: gateway rate limit ----------------------------------------------

describe("invoke_capability rate limit (fix-3)", () => {
  test("an exhausted budget -> rate_limited with a retry hint", async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      retryAfterSeconds: 60,
    });
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("rate_limited");
    expect(error.hint).toContain("60 seconds");
    // Refused before the handler ran: the org-settings loader was not consulted.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("the limiter is consulted per (organization, capability)", async () => {
    await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(consumeRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityId: "time-entries.export-csv" }),
    );
  });
});

// --- fix-4: archived-workspace gate allows unarchive-shaped invokes ---------

describe("invoke_capability archived-workspace gate (fix-4)", () => {
  const archivedCtx = () =>
    createContext({
      workspaceIds: ["ws_arch"],
      archivedWorkspaceIds: ["ws_arch"],
    });

  test("an allowsArchivedWorkspace write passes the gate on an archived workspace", async () => {
    // validateOnly reaches (and clears) the workspace gate without executing, so
    // this asserts the gate result independent of the unarchive DB work.
    const result = await handleMcpToolCall({
      args: {
        capability: "workspaces.unarchive",
        input: { params: { workspaceId: "ws_arch" } },
        validateOnly: true,
      },
      context: archivedCtx(),
      toolName: "invoke_capability",
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "workspaces.unarchive",
    });
  });

  test("a normal write is still refused on an archived workspace", async () => {
    // case-law.matter-links.create is a workspace write without the
    // allowsArchivedWorkspace flag, and its only body field is a UUID (so input
    // validation passes and the archived-workspace gate is what refuses it).
    const result = await handleMcpToolCall({
      args: {
        capability: "case-law.matter-links.create",
        input: {
          params: { workspaceId: "ws_arch" },
          body: { decisionId: "00000000-0000-0000-0000-000000000000" },
        },
        validateOnly: true,
      },
      context: archivedCtx(),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("not_found");
  });
});

// --- fix-5: validateOnly runs workspace resolution first ---------------------

describe("invoke_capability validateOnly ordering (fix-5)", () => {
  test("validateOnly on a workspace capability fails when the workspace is missing", async () => {
    // time-entries.export-csv declares no params schema, so pre-fix validateOnly
    // returned { valid: true } before any workspace check. Now resolution runs
    // first, so a missing workspaceId surfaces as it would on a real invoke.
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: {},
        validateOnly: true,
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("validateOnly succeeds once the workspace resolves, still without executing", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
        validateOnly: true,
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "time-entries.export-csv",
    });
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- fix-6: file/stream capabilities refused --------------------------------

describe("invoke_capability file-response gate (fix-6)", () => {
  test("(layer a) a returnsFileResponse capability is refused pre-execution", async () => {
    const result = await handleMcpToolCall({
      args: { capability: "clauses.export" },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("file or stream");
    // Refused before dispatch: no handler ran.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("(layer a) a helper-built binary capability is refused pre-execution", async () => {
    // time-entries.export-pdf returns a Uint8Array (not a Response) via a
    // helper; the flag refuses it before dispatch.
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-pdf",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("file or stream");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("(layer b) mapHandlerResult refuses a Response the handler returns", () => {
    const mapped = mapHandlerResult({
      id: "x.y",
      result: new Response("file bytes"),
      access: "read",
    });
    expect(mappedError(mapped).code).toBe("feature_disabled");
  });

  test("(layer b) mapHandlerResult refuses every binary payload shape", () => {
    const binaries: [string, unknown][] = [
      ["Uint8Array", new Uint8Array([37, 80, 68, 70])],
      ["ArrayBuffer", new ArrayBuffer(8)],
      ["DataView (ArrayBuffer view)", new DataView(new ArrayBuffer(8))],
      ["ReadableStream", new ReadableStream()],
      ["Blob", new Blob(["bytes"])],
    ];
    for (const [label, value] of binaries) {
      const mapped = mapHandlerResult({
        id: "x.y",
        result: value,
        access: "read",
      });
      expect(mappedError(mapped).code, label).toBe("feature_disabled");
    }
  });

  test("(layer b) mapHandlerResult passes a plain payload through", () => {
    const mapped = mapHandlerResult({
      id: "x.y",
      result: { ok: true },
      access: "read",
    });
    expect(mapped).toEqual({
      egress: "structured",
      payload: { ok: true },
      textFields: [],
    });
  });

  test("(layer b) a WRITE success payload carries the request receipt under meta", () => {
    const mapped = runWithRequestId("req_invoke", () =>
      mapHandlerResult({ id: "x.y", result: { ok: true }, access: "write" }),
    );
    expect(mapped).toEqual({
      egress: "structured",
      payload: { ok: true, meta: { requestId: "req_invoke" } },
      textFields: [],
    });
  });

  test("(layer b) a READ success payload carries NO receipt (deterministic for caching)", () => {
    const mapped = runWithRequestId("req_invoke", () =>
      mapHandlerResult({ id: "x.y", result: { ok: true }, access: "read" }),
    );
    expect(mapped).toEqual({
      egress: "structured",
      payload: { ok: true },
      textFields: [],
    });
  });

  test("(layer b) mapHandlerResult maps a status response onto the envelope", () => {
    const mapped = mapHandlerResult({
      id: "x.y",
      result: new ElysiaCustomStatusResponse(404, { message: "Gone" }),
      access: "read",
    });
    expect(mappedError(mapped).code).toBe("not_found");
  });
});

// --- file-input capabilities refused (t.File over JSON) ----------------------

describe("invoke_capability file-input gate", () => {
  test("a requiresFileInput capability is refused pre-execution on invoke", async () => {
    // entities.upload's body carries t.File(); JSON cannot deliver a File, so
    // the gate refuses before validation/dispatch with a presigned-flow hint.
    const result = await handleMcpToolCall({
      args: {
        capability: "entities.upload",
        input: {
          params: { workspaceId: "ws_1" },
          body: { file: "not-a-file" },
        },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("file upload");
    expect(error.hint).toContain("presigned");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("validateOnly is refused too (a string would falsely validate as a File)", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "entities.upload",
        input: {
          params: { workspaceId: "ws_1" },
          body: { file: "not-a-file" },
        },
        validateOnly: true,
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("feature_disabled");
  });

  test("describe_capability exposes requiresFileInput", async () => {
    const flagged = await call("describe_capability", {
      capability: "entities.upload",
    });
    expect(
      parseToolPayload<{ requiresFileInput: boolean }>(flagged)
        .requiresFileInput,
    ).toBe(true);

    const plain = await call("describe_capability", {
      capability: "time-entries.create",
    });
    expect(
      parseToolPayload<{ requiresFileInput: boolean }>(plain).requiresFileInput,
    ).toBe(false);
  });

  test("the catalog flag matches the live schema (mechanical derivation)", () => {
    // Every t.File-bearing catalog capability carries the flag; three known
    // seeds spot-check the derivation. `in` narrowing because the JSON module
    // type only carries the field on flagged entries.
    const flagged = new Set(
      capabilityCatalog
        .filter((e) => "requiresFileInput" in e && e.requiresFileInput)
        .map((e) => e.id),
    );
    for (const id of [
      "entities.upload",
      "clauses.import",
      "templates.create",
    ]) {
      expect(flagged.has(id), id).toBe(true);
    }
    expect(flagged.has("time-entries.export-csv")).toBe(false);
  });
});

// Read the error envelope out of a raw mapHandlerResult return (a CallToolResult
// for the error cases), without going through the egress pipeline.
const mappedError = (
  mapped: ReturnType<typeof mapHandlerResult>,
): ErrorEnvelope => {
  if (!("content" in mapped)) {
    throw new Error(`Expected an error result, got: ${JSON.stringify(mapped)}`);
  }
  const item = mapped.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text error result");
  }
  return asTestRaw<{ error: ErrorEnvelope }>(JSON.parse(item.text)).error;
};

// --- meta-tool argument shape validation (fail-closed dry runs) ---------------

describe("invoke_capability argument shape validation", () => {
  test('validateOnly: "true" (string) -> validation_error, capability NOT executed', async () => {
    // The transport does not enforce the advertised JSON Schema; a mistyped
    // dry-run flag silently read as false would EXECUTE the capability.
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "Dry run intended" } },
        validateOnly: "true",
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "validateOnly")).toBe(true);
    // Refused before any dispatch: the org-settings loader never ran.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test('confirm: "yes" (string) -> validation_error, not confirmation_required', async () => {
    const result = await handleMcpToolCall({
      args: { capability: "clauses.categories-delete", confirm: "yes" },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "confirm")).toBe(true);
  });

  test("non-object input -> validation_error", async () => {
    const result = await handleMcpToolCall({
      args: { capability: "clauses.categories-create", input: "not-an-object" },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "input")).toBe(true);
  });

  test("non-object input parts -> validation_error naming each part", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: "text body", params: 7 },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "input.body")).toBe(true);
    expect(issues.some((i) => i.path === "input.params")).toBe(true);
  });

  test("sibling meta-tools already reject mistyped args (no coercion)", async () => {
    // list_capabilities limit must be a JSON integer, not a numeric string.
    const list = await call("list_capabilities", { limit: "5" });
    expect(errorEnvelope(list).code).toBe("validation_error");
    // describe_capability's capability must be a string.
    const described = await call("describe_capability", { capability: 42 });
    expect(errorEnvelope(described).code).toBe("validation_error");
  });
});

// --- Elysia-boundary input normalization (Value.Clean parity) ----------------

describe("invoke_capability input normalization", () => {
  test("unknown keys on a closed schema are stripped, not rejected (REST parity)", async () => {
    // tasks.calendar's body schema is additionalProperties: false; the Elysia
    // boundary CLEANS unknown keys before validation (verified empirically),
    // so the generic path must accept-and-strip too, not reject.
    const result = await handleMcpToolCall({
      args: {
        capability: "tasks.calendar",
        input: {
          params: { workspaceId: "ws_1" },
          body: {
            dateFrom: "2026-01-01T00:00:00.000Z",
            dateTo: "2026-01-31T00:00:00.000Z",
            datePropertyIds: ["prop_1"],
            unknownExtra: "would fail additionalProperties:false without Clean",
          },
        },
        validateOnly: true,
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({ valid: true, capability: "tasks.calendar" });
  });

  test("workspaceId still resolves when the config params schema omits it", async () => {
    // The route macro owns workspaceId at REST; Clean must not break the
    // resolution for configs that do not declare it (raw-params read).
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(parseToolPayload<string>(result)).toContain("Date,");
  });
});

// --- deployment feature gates -------------------------------------------------

describe("invoke_capability deployment feature gate", () => {
  test("a gated-off capability is refused on invoke with feature_disabled", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("not enabled on this deployment");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("validateOnly is refused too (the gate runs before everything)", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
        validateOnly: true,
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("feature_disabled");
  });

  test("describe_capability refuses a gated-off entry (no schema leak)", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await call("describe_capability", {
      capability: "time-entries.export-csv",
    });
    expect(errorEnvelope(result).code).toBe("feature_disabled");
  });

  test("list_capabilities does not advertise gated-off entries", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await call("list_capabilities", {
      domain: "time-entries",
      limit: 50,
    });
    const payload = parseToolPayload<{ items: { id: string }[] }>(result);
    expect(payload.items).toHaveLength(0);
  });

  test("the same capability works again once the flag is on", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_1" } },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    expect(parseToolPayload<string>(result)).toContain("Date,");
  });

  test("describe exposes the feature flag on an enabled entry", async () => {
    const result = await call("describe_capability", {
      capability: "time-entries.export-csv",
    });
    const payload = parseToolPayload<{ feature: string | null }>(result);
    expect(payload.feature).toBe("FEATURE_TIME_BILLING");
  });
});

// --- expected-status mapping (409 conflict et al.) ----------------------------

describe("status-to-envelope mapping", () => {
  test("a handler 409 maps to conflict, preserving the handler's message", () => {
    const mapped = mapHandlerResult({
      id: "case-law.matter-links.create",
      result: new ElysiaCustomStatusResponse(409, {
        message: "Decision already linked to this matter",
      }),
      access: "write",
    });
    const error = mappedError(mapped);
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("Decision already linked to this matter");
  });

  test("a handler 422 maps to validation_error, preserving the message", () => {
    const mapped = mapHandlerResult({
      id: "x.y",
      result: new ElysiaCustomStatusResponse(422, {
        message: "dateFrom must precede dateTo",
      }),
      access: "read",
    });
    const error = mappedError(mapped);
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("dateFrom must precede dateTo");
  });

  test("a handler 401 maps to permission_denied", () => {
    const mapped = mapHandlerResult({
      id: "x.y",
      result: new ElysiaCustomStatusResponse(401, { message: "Unauthorized" }),
      access: "read",
    });
    expect(mappedError(mapped).code).toBe("permission_denied");
  });

  test("a 5xx stays internal_error with a generic message (no leak)", () => {
    const mapped = mapHandlerResult({
      id: "x.y",
      result: new ElysiaCustomStatusResponse(502, {
        message: "upstream gotenberg at 10.0.3.7 refused",
      }),
      access: "read",
    });
    const error = mappedError(mapped);
    expect(error.code).toBe("internal_error");
    expect(error.message).not.toContain("10.0.3.7");
  });
});
