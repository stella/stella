import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { runWithRequestId } from "@/api/lib/observability/request-context";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

// --- Mocks, installed before the MCP graph is imported -----------------------

const captureErrorMock = mock();
const realAnalytics = await import("@/api/lib/analytics/capture");
void mock.module("@/api/lib/analytics/capture", () => ({
  ...realAnalytics,
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

const realLoader = await import("@/api/lib/ai-config-loader");
const loadOrgSettingsMock = mock(async () => ({
  orgAIConfig: null,
  orgAIConfigStatus: "ok",
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
const { synthesizeCapabilityContext } =
  await import("@/api/mcp/capability-context");
const { ElysiaCustomStatusResponse } = await import("elysia");
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
  credentialPermissions,
  grantedScopes = [
    "stella:read",
    "stella:billing_write",
    "stella:knowledge_write",
    "stella:matters_write",
  ],
  memberRole = "owner",
  scopedDb = emptyScopedDb,
  safeDb = toSafeDbMock(emptyScopedDb),
  createOperationDatabaseScope,
  pinServerValidatedWorkspaceId,
  archivedWorkspaceIds = [] as string[],
  workspaceIds = ["ws_1"],
}: {
  createOperationDatabaseScope?: McpRequestContext["createOperationDatabaseScope"];
  credentialPermissions?: McpRequestContext["credentialPermissions"];
  grantedScopes?: readonly string[];
  memberRole?: McpRequestContext["memberRole"];
  pinServerValidatedWorkspaceId?: McpRequestContext["pinServerValidatedWorkspaceId"];
  scopedDb?: McpRequestContext["scopedDb"];
  safeDb?: McpRequestContext["safeDb"];
  archivedWorkspaceIds?: string[];
  workspaceIds?: string[];
} = {}): McpRequestContext => {
  const accessibleWorkspaceIdSet = new Set(workspaceIds);
  return {
    accessibleWorkspaceIds: workspaceIds.map((id) => toSafeId<"workspace">(id)),
    accessibleWorkspaceIdSet,
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
    createOperationDatabaseScope:
      createOperationDatabaseScope ??
      (() => ({
        pinServerValidatedWorkspaceId: (workspaceId) =>
          accessibleWorkspaceIdSet.has(workspaceId),
        safeDb,
        scopedDb,
      })),
    credentialPermissions,
    grantedScopes,
    memberRole,
    organizationId: toSafeId<"organization">("org_1"),
    request: new Request("http://localhost/mcp"),
    recordAuditEvent: noopRecorder,
    pinServerValidatedWorkspaceId,
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  };
};

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

describe("generated capability catalog", () => {
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
      items: {
        id: string;
        summary: string;
        scope: string;
        access: string;
        destructive: boolean;
        handlerKind: string;
        transport: { type: string; invocable: boolean };
      }[];
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
      expect(["read", "write"]).toContain(item.access);
      expect(typeof item.destructive).toBe("boolean");
      expect(["workspace", "root"]).toContain(item.handlerKind);
      expect(["json", "file-input", "file-response", "file-both"]).toContain(
        item.transport.type,
      );
      expect(typeof item.transport.invocable).toBe("boolean");
    }

    const second = await call("list_capabilities", {
      limit: 5,
      cursor: payload.nextCursor,
    });
    const secondPayload = parseToolPayload<{ items: { id: string }[] }>(second);
    // Keyset by id: page two starts strictly after page one's last id.
    const lastOfFirst = payload.items.at(-1)?.id ?? "";
    expect(
      // oxlint-disable-next-line require-cached-collator/require-cached-collator -- keyset cursor ordering check against a capability id, not display text
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

  test("compound capability scope rejects a document-only grant", async () => {
    const result = await handleMcpToolCall({
      args: { capability: "templates.fill-to-workspace", input: {} },
      context: createContext({
        grantedScopes: ["stella:read", "stella:documents_write"],
      }),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("missing_scope");
    expect(error.message).toContain("stella:templates");
    expect(error.hint).toContain(
      "--scopes stella:read,stella:documents_write,stella:templates",
    );
  });

  test("documents mode reaches the canonical entity-version reservation with its advertised scopes", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.create",
        input: {
          body: {
            purpose: "entity_version",
            entityId: "00000000-0000-4000-8000-000000000001",
            name: "agreement.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 42,
            sha256Hex: "a".repeat(64),
          },
          params: { workspaceId: "ws_1" },
        },
        validateOnly: true,
      },
      context: createContext({
        grantedScopes: [
          "stella:read",
          "stella:documents_write",
          "stella:matters_write",
        ],
      }),
      mode: "documents",
      toolName: "invoke_capability",
    });

    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "uploads.create",
    });
  });

  // Scope-gate outcome for a read capability under a given granted-scope set.
  // validateOnly stops after the scope + destructive gates, so the result is
  // never the handler's DB execution: it is `missing_scope` when the gate
  // rejects, and anything else (validation payload / validation_error) when the
  // gate is satisfied.
  const scopeGateCode = async (
    capability: string,
    grantedScopes: readonly string[],
  ): Promise<string> => {
    const result = await handleMcpToolCall({
      args: { capability, input: {}, validateOnly: true },
      context: createContext({ grantedScopes }),
      toolName: "invoke_capability",
    });
    const payload = parseToolPayload(result);
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      return asTestRaw<{ error: { code: string } }>(payload).error.code;
    }
    return "ok";
  };

  test("a domain write scope alone does not satisfy a read", async () => {
    // entities.get is a matters-domain read whose scope is stella:read. The
    // gate is a flat scope check, so holding only stella:matters_write does not
    // reach it — a read credential must carry the read scope (which the default
    // consent bundle always includes). This pins the gate as flat, so a future
    // "write implies read" change is a deliberate edit here, not an accident.
    expect(await scopeGateCode("entities.get", ["stella:matters_write"])).toBe(
      "missing_scope",
    );
  });

  test("stella:read alone reads across domains", async () => {
    // The whole point of the fix: a read-only credential can invoke read
    // capabilities in every domain, not just the read-only ones.
    const ids = ["entities.get", "time-entries.list", "clauses.list"];
    const codes = await Promise.all(
      ids.map(async (id) => await scopeGateCode(id, ["stella:read"])),
    );
    for (const code of codes) {
      expect(code).not.toBe("missing_scope");
    }
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

// --- invoke_capability: discriminated-union input errors --------------------

// Guards the "path-less union error" class: a failed discriminated union must
// name its discriminator field (and, once the discriminator matches a variant,
// that variant's own missing fields), never collapse to an opaque, unplaceable
// `Expected union value`. uploads.create's body is a flat union keyed by
// `purpose`, so it is the canonical driver.
describe("discriminated-union input validation names the field", () => {
  const uploadIssues = async (
    body: unknown,
  ): Promise<{ path: string; message: string }[]> => {
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.create",
        input: { params: { workspaceId: "ws_1" }, body },
      },
      context: createContext(),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    return asTestRaw<{ path: string; message: string }[]>(error.issues ?? []);
  };

  test("a body missing purpose names body.purpose with the allowed literals", async () => {
    const issues = await uploadIssues({});
    const purpose = issues.find((issue) => issue.path === "body.purpose");
    expect(purpose).toBeDefined();
    expect(purpose?.message).toContain('"entity_create"');
    expect(purpose?.message).toContain('"entity_version"');
    expect(purpose?.message).toContain('"agent_skill"');
  });

  test("a wrong purpose literal still names body.purpose", async () => {
    const issues = await uploadIssues({ purpose: "not_a_purpose" });
    expect(issues.some((issue) => issue.path === "body.purpose")).toBe(true);
  });

  test("a matched purpose drills into that variant's own missing fields", async () => {
    const issues = await uploadIssues({ purpose: "entity_create" });
    const paths = issues.map((issue) => issue.path);
    // The entity_create variant's required file metadata surfaces by name,
    // instead of a single opaque union error.
    expect(paths).toContain("body.propertyId");
    expect(issues.every((issue) => issue.path.startsWith("body."))).toBe(true);
  });

  test("INVARIANT: every union-body validation issue carries a non-empty path", async () => {
    const bodies: unknown[] = [
      {},
      { purpose: "not_a_purpose" },
      { purpose: "entity_create" },
      { purpose: "agent_skill" },
      { purpose: "entity_version", entityId: 5 },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- sequential invoke calls keep assertions ordered
      const issues = await uploadIssues(body);
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.path.length).toBeGreaterThan(0);
      }
    }
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
    const pinnedWorkspaceIds: string[] = [];
    const result = await handleMcpToolCall({
      args: {
        capability: "time-entries.export-csv",
        input: { params: { workspaceId: "ws_arch" } },
      },
      context: createContext({
        workspaceIds: ["ws_arch"],
        archivedWorkspaceIds: ["ws_arch"],
        pinServerValidatedWorkspaceId: (workspaceId) => {
          pinnedWorkspaceIds.push(workspaceId);
          return true;
        },
      }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("not_found");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
    expect(pinnedWorkspaceIds).toEqual([]);
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

  test("pins an active workspace only after capability access validation", async () => {
    const pinnedWorkspaceIds: string[] = [];
    const result = await handleMcpToolCall({
      args: {
        capability: "case-law.matter-links.create",
        input: {
          body: { decisionId: "00000000-0000-0000-0000-000000000000" },
          params: { workspaceId: "ws_1" },
        },
        validateOnly: true,
      },
      context: createContext({
        pinServerValidatedWorkspaceId: (workspaceId) => {
          pinnedWorkspaceIds.push(workspaceId);
          return true;
        },
      }),
      toolName: "invoke_capability",
    });

    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
    expect(pinnedWorkspaceIds).toEqual(["ws_1"]);
  });
});

describe("synthesized capability authorization lifetime", () => {
  test("preserves MCP provenance in recorders rebound to another workspace", async () => {
    let inserted: Record<string, unknown>[] = [];
    const context = createContext({ workspaceIds: ["ws_1", "ws_2"] });
    context.auditExecution = {
      performer: { id: "agent-1", name: "Agent 1", type: "agent" },
      trigger: {
        ownerUserId: toSafeId<"user">("user_1"),
        source: "mcp",
        type: "credential",
      },
    };
    const synthesized = await synthesizeCapabilityContext({
      capabilityId: "entities.copy-to-workspace",
      context,
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost/mcp"),
      workspaceId: toSafeId<"workspace">("ws_1"),
    });
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          inserted = rows;
        },
      }),
    });

    await synthesized.createAuditRecorder({
      workspaceId: toSafeId<"workspace">("ws_2"),
    })(tx, {
      action: "create",
      resourceId: "entity-1",
      resourceType: "entity",
    });

    expect(inserted[0]).toMatchObject({
      performerId: "agent-1",
      performerType: "agent",
      triggerSource: "mcp",
      triggerType: "credential",
      workspaceId: "ws_2",
    });
  });

  test("pins only the resolved workspace and later validated targets", async () => {
    const pinnedWorkspaceIds: string[] = [];
    const context = createContext({
      workspaceIds: ["ws_1", "ws_2"],
      createOperationDatabaseScope: () => ({
        pinServerValidatedWorkspaceId: (workspaceId) => {
          if (!pinnedWorkspaceIds.includes(workspaceId)) {
            pinnedWorkspaceIds.push(workspaceId);
          }
          return workspaceId === "ws_1" || workspaceId === "ws_2";
        },
        safeDb: toSafeDbMock(emptyScopedDb),
        scopedDb: emptyScopedDb,
      }),
    });
    const synthesized = await synthesizeCapabilityContext({
      capabilityId: "entities.copy-to-workspace",
      context,
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost/mcp"),
      workspaceId: toSafeId<"workspace">("ws_1"),
    });

    expect(pinnedWorkspaceIds).toEqual(["ws_1"]);
    await synthesized.getWorkspaceAccess(toSafeId<"workspace">("ws_2"));
    await synthesized.getWorkspaceAccess(toSafeId<"workspace">("ws_2"));
    expect(pinnedWorkspaceIds).toEqual(["ws_1", "ws_2"]);

    expect(
      await synthesized.getWorkspaceAccess(
        toSafeId<"workspace">("ws_inaccessible"),
      ),
    ).toBeNull();
    expect(pinnedWorkspaceIds).toEqual(["ws_1", "ws_2"]);
  });

  test("fails closed when an executable context lacks an operation scope", async () => {
    const context = createContext();
    context.createOperationDatabaseScope = undefined;

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await synthesizeCapabilityContext({
      capabilityId: "entities.copy-to-workspace",
      context,
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost/mcp"),
      workspaceId: toSafeId<"workspace">("ws_1"),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "missing an operation database scope",
    );
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

describe("invoke_capability upload purpose scope", () => {
  const skillPackBody = {
    purpose: "agent_skill",
    scope: "team",
    name: "pack.zip",
    mimeType: "application/zip",
    size: 1024,
    sha256Hex: "a".repeat(64),
  };
  const documentBody = {
    purpose: "entity_create",
    propertyId: "11111111-1111-4111-8111-111111111111",
    name: "contract.pdf",
    mimeType: "application/pdf",
    size: 1024,
    sha256Hex: "a".repeat(64),
  };
  const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
  // uploads.update declares workspaceId in its own params schema, so the id has
  // to satisfy the uuid pattern rather than the short test alias.
  const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

  // A pending upload the finalize gate reads its purpose from.
  const storedPurposeDb = (purpose: string) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      async (run: (tx: unknown) => unknown) => {
        const builder = {
          select: () => builder,
          from: () => builder,
          where: () => builder,
          orderBy: () => builder,
          limit: async () => [{ purpose }],
        };
        return await run(builder);
      },
    );

  test("a skill-pack upload needs the skills consent, not the domain scope alone", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { workspaceId: "ws_1" } },
        validateOnly: true,
      },
      context: createContext({ grantedScopes: ["stella:matters_write"] }),
      toolName: "invoke_capability",
    });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe("missing_scope");
    expect(envelope.message).toContain("stella:skills");
  });

  test("the skills consent admits the same call", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { workspaceId: "ws_1" } },
        validateOnly: true,
      },
      context: createContext({
        grantedScopes: ["stella:matters_write", "stella:skills"],
      }),
      toolName: "invoke_capability",
    });
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });

  test("a document upload still runs on the domain scope", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.create",
        input: { body: documentBody, params: { workspaceId: "ws_1" } },
        validateOnly: true,
      },
      context: createContext({ grantedScopes: ["stella:matters_write"] }),
      toolName: "invoke_capability",
    });
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });

  test("finalize takes the purpose from the stored upload, not from the caller", async () => {
    // The finalize call names only an upload id, so the consent it must hold is
    // the one its recorded purpose spends.
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.update",
        input: { params: { workspaceId: WORKSPACE_ID, uploadId: UPLOAD_ID } },
        validateOnly: true,
      },
      context: createContext({
        grantedScopes: ["stella:matters_write"],
        workspaceIds: [WORKSPACE_ID],
        scopedDb: storedPurposeDb("agent_skill"),
      }),
      toolName: "invoke_capability",
    });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe("missing_scope");
    expect(envelope.message).toContain("stella:skills");
  });

  test("finalizing a document upload stays on the domain scope", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "uploads.update",
        input: { params: { workspaceId: WORKSPACE_ID, uploadId: UPLOAD_ID } },
        validateOnly: true,
      },
      context: createContext({
        grantedScopes: ["stella:matters_write"],
        workspaceIds: [WORKSPACE_ID],
        scopedDb: storedPurposeDb("entity_create"),
      }),
      toolName: "invoke_capability",
    });
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });
});

describe("invoke_capability credential permission set", () => {
  test("a credential set that does not cover the capability -> permission_denied", async () => {
    // The role is owner, so the role half passes; the credential's own set does
    // not name `clause`, and authority is the AND of the two.
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "X" } },
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
      }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("an action the credential set omits on a resource it names -> permission_denied", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "X" } },
      },
      context: createContext({
        credentialPermissions: { clause: ["delete"] },
      }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("validateOnly reports the same refusal as execution would", async () => {
    const result = await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "X" } },
        validateOnly: true,
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
      }),
      toolName: "invoke_capability",
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("a refused call consumes no rate-limit budget", async () => {
    // The budget bounds work that runs. Charging it before the authority check
    // would let a caller who may not perform the capability spend their window
    // on refusals.
    await handleMcpToolCall({
      args: {
        capability: "clauses.categories-create",
        input: { body: { name: "X" } },
      },
      context: createContext({ memberRole: "intern" }),
      toolName: "invoke_capability",
    });
    expect(consumeRateLimitMock).not.toHaveBeenCalled();
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
  test("(layer a) a file-returning capability is refused pre-execution", async () => {
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
  test("a required-file capability is refused pre-execution, naming its alternative", async () => {
    // entities.upload's body carries a required t.File(); JSON cannot deliver a
    // File, so the gate refuses before validation/dispatch — and the hint
    // carries the presigned flow's real capability ids from the catalog, so the
    // agent gets a next call instead of a dead end.
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
    expect(error.message).toContain("requires a file in `file`");
    expect(error.hint).toContain("uploads.create");
    expect(error.hint).toContain("uploads.update");
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

  test("an OPTIONAL file field leaves the capability invocable in its JSON modes", async () => {
    // templates.prefill takes `file`, `text`, and `entityIds` as alternative
    // sources; only the first needs bytes. The old boolean dropped the whole
    // capability from every client — this asserts the JSON modes now reach
    // dispatch (the handler runs; whatever it returns is beyond this gate).
    const result = await handleMcpToolCall({
      args: {
        capability: "templates.prefill",
        input: {
          params: { templateId: "01234567-89ab-cdef-0123-456789abcdef" },
          body: { text: "Tenant: ACME" },
        },
        validateOnly: true,
      },
      context: createContext({ grantedScopes: ["stella:templates"] }),
      toolName: "invoke_capability",
    });
    // Reached validation: the input is accepted, not refused by a transport
    // gate. The old boolean returned `feature_disabled` here.
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });

  test("the withheld file field is refused, not silently dropped", async () => {
    // A caller who sent bytes-as-a-string must not get a success computed from
    // the other sources: the string would pass `format: "binary"` validation
    // and reach a handler expecting a `File`.
    const result = await handleMcpToolCall({
      args: {
        capability: "templates.prefill",
        input: {
          params: { templateId: "01234567-89ab-cdef-0123-456789abcdef" },
          body: { file: "not-a-file", text: "Tenant: ACME" },
        },
      },
      context: createContext({ grantedScopes: ["stella:templates"] }),
      toolName: "invoke_capability",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("cannot take `file`");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("describe_capability exposes the transport disposition", async () => {
    const flagged = await call("describe_capability", {
      capability: "entities.upload",
    });
    expect(
      parseToolPayload<{
        transport: { type: string; invocable: boolean; fileField: string };
      }>(flagged).transport,
    ).toMatchObject({
      type: "file-input",
      invocable: false,
      fileField: "file",
    });

    const fileless = await call("describe_capability", {
      capability: "templates.prefill",
    });
    expect(
      parseToolPayload<{
        transport: {
          invocable: boolean;
          fileField: string;
          fileFieldRequired: boolean;
        };
      }>(fileless).transport,
    ).toMatchObject({
      invocable: true,
      fileField: "file",
      fileFieldRequired: false,
    });

    const plain = await call("describe_capability", {
      capability: "time-entries.create",
    });
    expect(
      parseToolPayload<{ transport: { type: string; fileField: null } }>(plain)
        .transport,
    ).toMatchObject({ type: "json", fileField: null });
  });

  test("every catalog entry's transport matches the live schema's binary field", () => {
    // Declared set equals derived set, in both directions: the exporter proves
    // this at build time, and this asserts it on the artifact that actually
    // ships. Spot-checked ids keep a wiring mistake from making the sets
    // trivially equal (e.g. both empty).
    const declaredFileInput = new Set(
      capabilityCatalog
        .filter(
          (e) =>
            e.transport.type === "file-input" ||
            e.transport.type === "file-both",
        )
        .map((e) => e.id),
    );
    // The snapshot is compact JSON, so a `t.File()` field is literally
    // `"format":"binary"`. Entries whose schema exceeded the byte cap carry no
    // schema here; the exporter checks those against the LIVE schema, which is
    // why that check cannot live only in this test.
    const schemaBinary = new Set(
      capabilityCatalog
        .filter((e) => JSON.stringify(e).includes('"format":"binary"'))
        .map((e) => e.id),
    );
    expect([...declaredFileInput].sort()).toEqual([...schemaBinary].sort());
    for (const id of [
      "entities.upload",
      "clauses.import",
      "templates.create",
      "templates.prefill",
    ]) {
      expect(declaredFileInput.has(id), id).toBe(true);
    }
    expect(declaredFileInput.has("time-entries.export-csv")).toBe(false);
  });
});

// Read the typed error out of a raw mapHandlerResult return without going
// through MCP serialization.
const mappedError = (
  mapped: ReturnType<typeof mapHandlerResult>,
): ErrorEnvelope => {
  if (!("status" in mapped) || mapped.status !== "error") {
    throw new Error(`Expected an error result, got: ${JSON.stringify(mapped)}`);
  }
  if (mapped.error.type !== "structured") {
    throw new Error("Expected a structured error result");
  }
  const { type: _type, ...error } = mapped.error;
  return error;
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
