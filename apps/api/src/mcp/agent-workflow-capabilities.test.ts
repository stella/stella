import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract/mcp";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  AI_MEMORY_FEATURE_ID,
  FEATURE_REGISTRY,
} from "@/api/lib/feature-access/registry";
import type { McpRequestResources } from "@/api/mcp/context";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { expandSchemaDefs } from "../../../../packages/cli/src/expand-schema-defs.ts";

/**
 * The redline, memory and notification handlers agents reach through the
 * generic capability path rather than curated tools. Each case drives the real
 * executor with the committed catalog entry, so scope, matter, role and schema
 * refusals are the ones an MCP client or the CLI receives.
 */

const disabledFeatures = new Set<string>();
const MEMORY_FEATURE_FLAG =
  FEATURE_REGISTRY[AI_MEMORY_FEATURE_ID].deploymentFeature;
const { handleMcpToolCall } = await import("@/api/mcp/tools");
const { parseCatalog } = await import("@/api/mcp/capability-tools");
const { readCapabilityCatalog } =
  await import("@stll/cli/capability-catalog-data");
const catalog = parseCatalog(readCapabilityCatalog());

const MATTER = "00000000-0000-4000-8000-0000000000a1";
const ARCHIVED_MATTER = "00000000-0000-4000-8000-0000000000a2";
const OTHER_TENANT_MATTER = "00000000-0000-4000-8000-0000000000b1";
const ENTITY_ID = "00000000-0000-4000-8000-000000000001";
const SUGGESTION_ID = "00000000-0000-4000-8000-000000000002";
const MEMORY_ID = "00000000-0000-4000-8000-000000000003";
const NOTIFICATION_ID = "00000000-0000-4000-8000-000000000004";

/** Every exposed id with the decision its catalog entry must carry. */
const EXPOSED = {
  "docx-suggestions.list": {
    access: "read",
    scope: "stella:read",
    handlerKind: "workspace",
    feature: undefined,
  },
  "docx-suggestions.resolve": {
    access: "write",
    scope: "stella:documents_write",
    handlerKind: "workspace",
    feature: undefined,
  },
  "docx-suggestions.revert": {
    access: "write",
    scope: "stella:documents_write",
    handlerKind: "workspace",
    feature: undefined,
  },
  "memories.create": {
    access: "write",
    scope: "stella:memory_write",
    handlerKind: "root",
    feature: MEMORY_FEATURE_FLAG,
  },
  "memories.list": {
    access: "read",
    scope: "stella:chat",
    handlerKind: "root",
    feature: MEMORY_FEATURE_FLAG,
  },
  "memories.update": {
    access: "write",
    scope: "stella:memory_write",
    handlerKind: "root",
    feature: MEMORY_FEATURE_FLAG,
  },
  "notifications.list": {
    access: "read",
    scope: "stella:read",
    handlerKind: "root",
    feature: undefined,
  },
  "notifications.read-state.update": {
    access: "write",
    scope: "stella:matters_write",
    handlerKind: "root",
    feature: undefined,
  },
} as const;

type ExposedId = keyof typeof EXPOSED;

/** One valid input per capability, as an agent would send it. */
const VALID_INPUT = {
  "docx-suggestions.list": {
    params: { matterId: MATTER, entityId: ENTITY_ID },
    query: { status: "pending" },
  },
  "docx-suggestions.resolve": {
    params: {
      matterId: MATTER,
      entityId: ENTITY_ID,
      suggestionId: SUGGESTION_ID,
    },
    body: { status: "accepted", appliedMode: "tracked-changes" },
  },
  "docx-suggestions.revert": {
    params: {
      matterId: MATTER,
      entityId: ENTITY_ID,
      suggestionId: SUGGESTION_ID,
    },
  },
  "memories.create": {
    body: { scope: "user", kind: "preference", content: "Use OSCOLA" },
  },
  "memories.list": { query: { scope: "user" } },
  "memories.update": {
    params: { memoryId: MEMORY_ID },
    body: { status: "archived" },
  },
  "notifications.list": {},
  "notifications.read-state.update": {
    params: { notificationId: NOTIFICATION_ID },
  },
} as const satisfies Record<ExposedId, Record<string, unknown>>;

/** One input each capability's own schema refuses, and the path it names. */
const INVALID_INPUT = {
  "docx-suggestions.list": {
    input: {
      params: { matterId: MATTER, entityId: ENTITY_ID },
      query: { status: "open" },
    },
    path: "query.status",
  },
  "docx-suggestions.resolve": {
    input: {
      params: {
        matterId: MATTER,
        entityId: ENTITY_ID,
        suggestionId: SUGGESTION_ID,
      },
      body: { status: "accepted" },
    },
    path: "body",
  },
  "docx-suggestions.revert": {
    input: {
      params: { matterId: MATTER, entityId: ENTITY_ID, suggestionId: "s-1" },
    },
    path: "params.suggestionId",
  },
  "memories.create": {
    input: { body: { scope: "user", kind: "preference", content: "" } },
    path: "body",
  },
  "memories.list": { input: { query: { status: "deleted" } }, path: "query" },
  "memories.update": {
    input: { params: { memoryId: MEMORY_ID }, body: { status: "suggested" } },
    path: "body.status",
  },
  "notifications.list": { input: { query: { limit: 0 } }, path: "query" },
  "notifications.read-state.update": {
    input: { params: { notificationId: "n-1" } },
    path: "params.notificationId",
  },
} as const satisfies Record<
  ExposedId,
  { input: Record<string, unknown>; path: string }
>;

const ALL_SCOPES = [
  "stella:read",
  "stella:chat",
  "stella:memory_write",
  "stella:documents_write",
  "stella:matters_write",
] as const;

const noopRecorder = asTestRaw<AuditRecorder>(mock(async () => undefined));

// Every id a reference lookup names is visible, so validation reaches the
// handler's own permission and matter checks. Nothing here executes a write.
const visibleReferences = () =>
  createScopedDbMock({
    select: () => {
      const query = {
        from: () => query,
        where: (condition: SQL) => ({
          limit: async (count: number) =>
            new PgDialect()
              .sqlToQuery(condition)
              .params.filter((id): id is string => typeof id === "string")
              .slice(0, count)
              .map((id) => ({ id })),
        }),
      };
      return query;
    },
  });

const createContext = ({
  grantedScopes = ALL_SCOPES,
  memberRole = "owner",
}: {
  grantedScopes?: readonly string[];
  memberRole?: McpRequestResources["memberRole"];
} = {}): McpRequestResources => {
  const workspaces = [
    { id: toSafeId<"workspace">(MATTER), status: "active" as const },
    { id: toSafeId<"workspace">(ARCHIVED_MATTER), status: "archived" as const },
  ];
  const workspaceIds = new Set<string>(workspaces.map(({ id }) => id));
  const { safeDb, scopedDb } = visibleReferences();
  return {
    testDependencies: {
      loadOrgSettingsForAuth: async () => ({
        orgAIConfig: null,
        orgAIConfigStatus: "ok" as const,
        managedAIResidency: "eu" as const,
        promptCachingEnabled: false,
      }),
      consumeInvokeCapabilityRateLimit: async () => ({
        ok: true,
        retryAfterSeconds: 60,
      }),
      isCapabilityFeatureEnabled: (feature) =>
        feature === undefined || !disabledFeatures.has(feature),
    },
    featureAccessSnapshot: createFeatureAccessSnapshot({
      organizationId: "org_1",
      userId: "user_1",
      decisions: new Map([
        [
          AI_MEMORY_FEATURE_ID,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId: AI_MEMORY_FEATURE_ID,
            grants: {
              [AI_MEMORY_FEATURE_ID]: [
                { type: "organization", organizationId: "org_1" },
              ],
            },
            organizationId: "org_1",
            userId: "user_1",
            user: { email: "member@example.test", emailVerified: true },
            membership: true,
            deploymentEnabled: !disabledFeatures.has(MEMORY_FEATURE_FLAG),
          }),
        ],
      ]),
    }),
    accessibleWorkspaceIds: workspaces.map(({ id }) => id),
    accessibleWorkspaceIdSet: workspaceIds,
    accessibleWorkspaceStatusById: new Map(
      workspaces.map(({ id, status }) => [id, status]),
    ),
    accessibleWorkspaces: workspaces,
    createOperationDatabaseScope: () => ({
      pinServerValidatedWorkspaceId: (workspaceId) =>
        workspaceIds.has(workspaceId),
      safeDb,
      scopedDb,
    }),
    credentialPermissions: undefined,
    grantedScopes,
    memberRole,
    organizationId: toSafeId<"organization">("org_1"),
    request: new Request("http://localhost/mcp"),
    recordAuditEvent: noopRecorder,
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
    userEmail: "member@example.test",
  };
};

type ToolCallResult = Awaited<ReturnType<typeof handleMcpToolCall>>;

const payloadOf = (result: ToolCallResult): unknown => {
  const item = result.content.at(0);
  if (item?.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(item.text);
};

const errorOf = (
  result: ToolCallResult,
): { code: string; message: string; issues?: { path: string }[] } => {
  const payload = payloadOf(result);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("error" in payload)
  ) {
    throw new Error(`Expected an error envelope: ${JSON.stringify(payload)}`);
  }
  return asTestRaw<{
    error: { code: string; message: string; issues?: { path: string }[] };
  }>(payload).error;
};

const invoke = async ({
  capability,
  input,
  context = createContext(),
  validateOnly = false,
  confirm = true,
}: {
  capability: ExposedId;
  input: Record<string, unknown>;
  context?: McpRequestResources;
  validateOnly?: boolean;
  confirm?: boolean;
}) =>
  await handleMcpToolCall({
    mode: "advanced",
    toolName: MCP_CAPABILITY_EXECUTORS[EXPOSED[capability].access],
    args: {
      capability,
      input,
      ...(validateOnly ? { validate_only: true } : {}),
      ...(confirm && EXPOSED[capability].access === "write"
        ? { confirm: true }
        : {}),
    },
    context,
  });

const EXPOSED_IDS = Object.keys(EXPOSED).filter(
  (id): id is ExposedId => id in EXPOSED,
);

beforeEach(() => {
  disabledFeatures.clear();
});

describe("agent workflow capability census", () => {
  test("persistent memory and redline writes require fresh confirmation and explicit consent", async () => {
    const guarded = catalog.filter(
      (entry) =>
        entry.access === "write" &&
        ["memories", "docx-suggestions"].includes(
          entry.id.split(".").at(0) ?? "",
        ),
    );
    expect(guarded.length).toBeGreaterThan(0);
    for (const entry of guarded) {
      expect(entry.confirmation, entry.id).toBe("required");
      expect(entry.destructive, entry.id).toBe(false);
      const capability = EXPOSED_IDS.find((id) => id === entry.id);
      if (capability === undefined) {
        throw new TypeError("Unexercised guarded capability");
      }
      const response = await invoke({
        capability,
        input: VALID_INPUT[capability],
        confirm: false,
      });
      expect(errorOf(response).code, entry.id).toBe("confirmation_required");
      const unavailable = await invoke({
        capability,
        input: VALID_INPUT[capability],
        context: {
          ...createContext(),
          toolConfirmation: TOOL_CONFIRMATION.unavailable,
        },
      });
      expect(errorOf(unavailable).code, entry.id).toBe("permission_denied");
      if (entry.id.startsWith("memories.")) {
        expect(entry.scope).toBe("stella:memory_write");
        expect(
          MCP_DEFAULT_RESOURCE_SCOPES.some((scope) => scope === entry.scope),
        ).toBe(false);
        const missing = await invoke({
          capability,
          input: VALID_INPUT[capability],
          context: createContext({ grantedScopes: ["stella:chat"] }),
        });
        expect(errorOf(missing).code).toBe("missing_scope");
      }
    }
  });

  test("the three domains expose exactly the reviewed capabilities", () => {
    const domains = new Set(["docx-suggestions", "memories", "notifications"]);
    const exposed = catalog
      .map(({ id }) => id)
      .filter((id) => domains.has(id.split(".").at(0) ?? ""))
      .toSorted();
    expect(exposed).toEqual(EXPOSED_IDS.toSorted());
  });

  test.each(EXPOSED_IDS)(
    "%s carries its scope, access, kind, feature and description",
    (id) => {
      const entry = catalog.find((candidate) => candidate.id === id);
      expect(entry).toMatchObject({
        id,
        access: EXPOSED[id].access,
        scope: EXPOSED[id].scope,
        handlerKind: EXPOSED[id].handlerKind,
        destructive: false,
        // A capability disposition is never a curated tool, so these spend
        // nothing from the connect-time tool list.
        mcp: { type: "capability" },
      });
      expect(entry && "feature" in entry ? entry.feature : undefined).toBe(
        EXPOSED[id].feature,
      );
      expect(entry?.description?.length ?? 0).toBeGreaterThan(40);
    },
  );
});

describe("agent workflow capability schemas", () => {
  test.each(EXPOSED_IDS)(
    "%s: describe_capability advertises the catalog schema",
    async (id) => {
      const described = asTestRaw<{ inputSchema: unknown }>(
        payloadOf(
          await handleMcpToolCall({
            mode: "advanced",
            toolName: "describe_capability",
            args: { capability: id },
            context: createContext(),
          }),
        ),
      );
      const entry = catalog.find((candidate) => candidate.id === id);
      expect(entry?.inputSchema).toBeDefined();
      expect(described.inputSchema).toEqual(
        expandSchemaDefs(entry?.inputSchema ?? {}),
      );
    },
  );

  test.each(EXPOSED_IDS)("%s: a valid input validates", async (id) => {
    const result = await invoke({
      capability: id,
      input: VALID_INPUT[id],
      validateOnly: true,
    });
    expect(payloadOf(result)).toEqual({
      result: { valid: true, capability: id },
    });
  });

  test.each(EXPOSED_IDS)(
    "%s: an input its schema refuses names the field",
    async (id) => {
      const { input, path } = INVALID_INPUT[id];
      const error = errorOf(
        await invoke({ capability: id, input, validateOnly: true }),
      );
      expect(error.code).toBe("validation_error");
      expect(error.issues?.some((issue) => issue.path.startsWith(path))).toBe(
        true,
      );
    },
  );
});

describe("agent workflow capability refusals", () => {
  test.each(EXPOSED_IDS)("%s: a credential without its scope", async (id) => {
    const grantedScopes = ALL_SCOPES.filter(
      (scope) => scope !== EXPOSED[id].scope,
    );
    const error = errorOf(
      await invoke({
        capability: id,
        input: VALID_INPUT[id],
        context: createContext({ grantedScopes }),
      }),
    );
    expect(error.code).toBe("missing_scope");
    expect(error.message).toContain(EXPOSED[id].scope);
  });

  test.each([
    "docx-suggestions.list",
    "docx-suggestions.resolve",
    "docx-suggestions.revert",
  ] as const)("%s: a closed matter is not found", async (id) => {
    const input = VALID_INPUT[id];
    const error = errorOf(
      await invoke({
        capability: id,
        input: {
          ...input,
          params: { ...input.params, matterId: ARCHIVED_MATTER },
        },
      }),
    );
    expect(error.code).toBe("not_found");
  });

  test.each([
    "docx-suggestions.list",
    "docx-suggestions.resolve",
    "docx-suggestions.revert",
  ] as const)("%s: another tenant's matter is not found", async (id) => {
    const input = VALID_INPUT[id];
    const error = errorOf(
      await invoke({
        capability: id,
        input: {
          ...input,
          params: { ...input.params, matterId: OTHER_TENANT_MATTER },
        },
      }),
    );
    expect(error.code).toBe("not_found");
  });

  test.each([
    ["a closed matter", ARCHIVED_MATTER],
    ["another tenant's matter", OTHER_TENANT_MATTER],
  ])("memories.create refuses matter memory in %s", async (_label, matter) => {
    const error = errorOf(
      await invoke({
        capability: "memories.create",
        input: {
          body: {
            scope: "workspace",
            matterId: matter,
            kind: "fact",
            content: "The counterparty is represented by external counsel",
          },
        },
      }),
    );
    expect(error.code).toBe("not_found");
  });

  test("memories.create refuses a matter-only kind on personal memory", async () => {
    const error = errorOf(
      await invoke({
        capability: "memories.create",
        input: {
          body: { scope: "user", kind: "fact", content: "A matter fact" },
        },
      }),
    );
    expect(error.code).toBe("validation_error");
  });

  test("an intern may not write matter memory", async () => {
    const error = errorOf(
      await invoke({
        capability: "memories.create",
        input: {
          body: {
            scope: "workspace",
            matterId: MATTER,
            kind: "fact",
            content: "The counterparty is represented by external counsel",
          },
        },
        context: createContext({ memberRole: "intern" }),
      }),
    );
    expect(error.code).toBe("permission_denied");
  });

  test.each([
    ["external", "memories.list"],
    ["external", "memories.create"],
    ["external", "memories.update"],
    ["intern", "docx-suggestions.resolve"],
    ["intern", "docx-suggestions.revert"],
  ] as const)("a role of %s may not call %s", async (memberRole, id) => {
    const error = errorOf(
      await invoke({
        capability: id,
        input: VALID_INPUT[id],
        context: createContext({ memberRole }),
      }),
    );
    expect(error.code).toBe("permission_denied");
  });

  test.each(["memories.list", "memories.create", "memories.update"] as const)(
    "%s is unavailable while assistant memory is switched off",
    async (id) => {
      const admittedContext = createContext();
      disabledFeatures.add(MEMORY_FEATURE_FLAG);
      const error = errorOf(
        await invoke({
          capability: id,
          input: VALID_INPUT[id],
          context: admittedContext,
        }),
      );
      expect(error.code).toBe("feature_disabled");
      const unadmitted = await invoke({
        capability: id,
        input: VALID_INPUT[id],
        context: createContext(),
      });
      expect(errorOf(unadmitted).code).toBe("not_found");
    },
  );
});
