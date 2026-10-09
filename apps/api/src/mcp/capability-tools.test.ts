import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { FILE_PROPERTY_TYPE_IMMUTABLE_CODE } from "@stll/api-contract/property-policy";
import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";

import type { Transaction } from "@/api/db/root";
import type { workspaceViews } from "@/api/db/schema";
import { auditLogs } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import exportTimeEntriesCsv from "@/api/handlers/time-entries/csv/export";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { PLAYBOOK_RUN_FAILURE_CODE } from "@/api/lib/document-review/playbook-run-refusal";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { runWithRequestId } from "@/api/lib/observability/request-context";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { isRecord } from "@/api/lib/type-guards";
import type { AdvertisedSchemas } from "@/api/mcp/advertised-schema";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { MCP_ERROR_CODES, projectMcpRefusal } from "@/api/mcp/error-codes";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { MAX_LIST_LIMIT } from "@/api/mcp/tool-utils";
import { modelViewOf } from "@/api/tests/helpers/mcp-model-view";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

const loadOrgSettingsMock = mock(async () => ({
  orgAIConfig: null,
  orgAIConfigStatus: "ok" as const,
  managedAIResidency: "eu" as const,
  promptCachingEnabled: false,
}));
// Waive one capability so the refusal path is exercised; the real table is empty.
const contextFidelityWaivers = new Map([
  ["billing-codes.create", "test-only waiver: needs response headers"],
]);

// Stub the gateway rate limit so execution tests are not throttled; a single
// test flips it to exhausted to assert the rate_limited envelope. Restored by
// afterAll(mock.restore).
const consumeRateLimitMock = mock(async () => ({
  ok: true,
  retryAfterSeconds: 60,
}));

// Controllable feature gate: the real module short-circuits on the dev test
// env, so the deployment-gate tests toggle flags through this set instead
// (cleared in beforeEach). Default (empty set) behaves like everything-enabled.
const disabledFeatures = new Set<string>();
const { handleMcpToolCall, listMcpTools } = await import("@/api/mcp/tools");
const { featureOmittedCapabilityIds, mapHandlerResult } =
  await import("@/api/mcp/capability-tools");
const { UPLOAD_PURPOSE_GATE_BY_CAPABILITY } =
  await import("@/api/mcp/upload-purpose-gate");
const { synthesizeCapabilityContext } =
  await import("@/api/mcp/capability-context");
const { listStaticMcpToolDefinitions } =
  await import("@/api/mcp/static-tool-definitions");
const { listMcpResources, readMcpResource } =
  await import("@/api/mcp/resources");
const { ElysiaCustomStatusResponse } = await import("elysia");
const { readCapabilityCatalog } =
  await import("@stll/cli/capability-catalog-data");
const { parseCatalog } = await import("@/api/mcp/capability-tools");
const capabilityCatalog = parseCatalog(readCapabilityCatalog());

const requiresVerificationGrant = (entry: (typeof capabilityCatalog)[number]) =>
  "featureId" in entry &&
  entry.featureId === LIST_VERIFICATION_FEATURE_ID &&
  "featureAccess" in entry &&
  entry.featureAccess === "required";

// --- Helpers -----------------------------------------------------------------

type ToolCallResult = Awaited<ReturnType<typeof handleMcpToolCall>>;

/**
 * The tool's payload as a client reads it: capability executor's `{ result }`
 * envelope is unwrapped, as the CLI and the MCP apps do.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter IS the API: callers pin the parsed shape per assertion
const parseToolPayload = <T = unknown>(result: ToolCallResult): T => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  const parsed: unknown = JSON.parse(item.text);
  const envelope = result.structuredContent;
  const isCapabilityEnvelope =
    isRecord(envelope) &&
    Object.keys(envelope).length === 1 &&
    Object.hasOwn(envelope, "result");
  return asTestRaw<T>(
    isCapabilityEnvelope &&
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed
      ? parsed.result
      : parsed,
  );
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

const visibleReferenceDatabase = (ids: readonly string[]) =>
  createScopedDbMock({
    select: () => {
      const query = {
        from: () => query,
        where: (condition: SQL) => ({
          limit: async (count: number) =>
            new PgDialect()
              .sqlToQuery(condition)
              .params.filter(
                (id): id is string =>
                  typeof id === "string" && ids.includes(id),
              )
              .slice(0, count)
              .map((id) => ({ id })),
        }),
      };
      return query;
    },
  });

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
  toolConfirmation,
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
  toolConfirmation?: McpRequestContext["toolConfirmation"];
} = {}): McpRequestContext => {
  const accessibleWorkspaceIdSet = new Set(workspaceIds);
  return {
    testDependencies: {
      loadOrgSettingsForAuth: loadOrgSettingsMock,
      consumeInvokeCapabilityRateLimit: consumeRateLimitMock,
      isCapabilityFeatureEnabled: (feature) =>
        feature === undefined || !disabledFeatures.has(feature),
      contextFidelityWaivers,
    },
    featureAccessSnapshot: createFeatureAccessSnapshot({
      organizationId: "org_1",
      userId: "user_1",
      decisions: new Map(
        Object.entries(FEATURE_REGISTRY).map(([featureId, definition]) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            grants: {},
            featureId,
            organizationId: "org_1",
            userId: "user_1",
            membership: true,
            user: { email: "standard@example.test", emailVerified: true },
            enrolments:
              definition.enrolment === "self-serve"
                ? [{ featureId, organizationId: "org_1", userId: "user_1" }]
                : [],
          }),
        ]),
      ),
    }),
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
    ...(toolConfirmation === undefined ? {} : { toolConfirmation }),
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  };
};

const call = async (toolName: string, args: Record<string, unknown>) =>
  await handleMcpToolCall({ args, context: createContext(), toolName });

const capabilityExecutorFor = (args: Record<string, unknown>) => {
  const entry = capabilityCatalog.find(
    (candidate) => candidate.id === args["capability"],
  );
  // Invalid and unknown ids exercise the write executor's argument/error boundary.
  return entry === undefined
    ? MCP_CAPABILITY_EXECUTORS.write
    : MCP_CAPABILITY_EXECUTORS[entry.access];
};
const handleCapabilityCall = async (
  options: Omit<Parameters<typeof handleMcpToolCall>[0], "toolName">,
) =>
  await handleMcpToolCall({
    ...options,
    toolName: capabilityExecutorFor(options.args),
  });
const callCapability = async (args: Record<string, unknown>) =>
  await call(capabilityExecutorFor(args), args);

let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
  loadOrgSettingsMock.mockClear();
  consumeRateLimitMock.mockClear();
  consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSeconds: 60 });
  disabledFeatures.clear();
});

afterEach(() => {
  analytics.restore();
});

describe("list verification access grants across MCP tools", () => {
  const matterId = "a1111111-1111-4111-8111-111111111111";
  const resourceId = "a2222222-2222-4222-8222-222222222222";
  const params = { matterId };
  const inputs = {
    "lists.verifications.create": {
      params,
      body: {
        listId: resourceId,
        entityId: resourceId,
        fileFieldId: resourceId,
      },
    },
    "lists.verifications.list": {
      params,
      query: { entityId: resourceId, fileFieldId: resourceId },
    },
    "lists.verifications.get": { params: { ...params, runId: resourceId } },
    "lists.verifications.latest.list": {
      params,
      body: { documents: [{ entityId: resourceId, fileFieldId: resourceId }] },
    },
    "lists.verifications.claim-reviews.create": {
      params,
      body: {
        runId: resourceId,
        claimId: resourceId,
        event: { kind: "note", note: "Synthetic review" },
      },
    },
    "lists.verifications.claim-reviews.bulk.create": {
      params,
      body: { runId: resourceId, claimIds: [resourceId] },
    },
    "lists.items.fact-details.update": {
      params,
      body: {
        listId: resourceId,
        itemEntityId: resourceId,
        occurredOn: null,
        evidenceKind: null,
        medium: null,
        confidence: "high",
        interpretationNote: null,
        scoring: "included",
      },
    },
    "lists.items.sources.verification.update": {
      params,
      body: {
        id: resourceId,
        listId: resourceId,
        itemEntityId: resourceId,
        status: "verified",
      },
    },
  } as const;

  let previousGrants = env.API_FEATURE_ACCESS_GRANTS;
  let previousDeploymentFlag = env.FEATURE_LEGAL_LISTS;

  beforeEach(() => {
    previousGrants = env.API_FEATURE_ACCESS_GRANTS;
    previousDeploymentFlag = env.FEATURE_LEGAL_LISTS;
    env.API_FEATURE_ACCESS_GRANTS = {};
    env.FEATURE_LEGAL_LISTS = true;
  });

  afterEach(() => {
    env.API_FEATURE_ACCESS_GRANTS = previousGrants;
    env.FEATURE_LEGAL_LISTS = previousDeploymentFlag;
  });

  const grantCurrentMember = () => {
    env.API_FEATURE_ACCESS_GRANTS = Object.fromEntries(
      [
        ...featurePrerequisiteClosure(
          FEATURE_REGISTRY,
          LIST_VERIFICATION_FEATURE_ID,
        ),
      ].map((id) => [
        id,
        [
          {
            type: "member" as const,
            organizationId: "org_1",
            email: "standard@example.test",
          },
        ],
      ]),
    );
  };

  type VerificationContextOptions = {
    email?: string;
    emailVerified?: boolean;
    membership?: "current" | "departed";
    organizationId?: string;
    userId?: string;
    viewRows?: (typeof workspaceViews.$inferSelect)[];
  };

  const verificationContext = ({
    email = "standard@example.test",
    emailVerified = true,
    membership = "current",
    organizationId = "org_1",
    userId = "user_1",
    viewRows = [],
  }: VerificationContextOptions = {}) => {
    let resourceLookups = 0;
    let mutations = 0;
    const tx = {
      select: (projection?: Record<string, unknown>) => {
        const identity =
          projection !== undefined && "emailVerified" in projection;
        if (!identity) {
          resourceLookups += 1;
        }
        const identityRows =
          membership === "current"
            ? [
                {
                  email,
                  emailVerified,
                  role: "owner",
                  workspaceId: matterId,
                  workspaceStatus: "active",
                  clientId: null,
                  workspaceMemberId: resourceId,
                },
              ]
            : [];
        const referenceProbe =
          projection !== undefined &&
          Object.keys(projection).length === 1 &&
          "id" in projection;
        const selectedRows = () => {
          if (identity) {
            return identityRows;
          }
          if (referenceProbe) {
            return [{ id: resourceId }];
          }
          return viewRows;
        };
        const rows = selectedRows();
        const query = [...rows];
        const builder = Object.assign(query, {
          from: () => query,
          innerJoin: () => query,
          leftJoin: () => query,
          where: () => query,
          groupBy: () => query,
          orderBy: () => query,
          limit: () => query,
          for: () => query,
        });
        return builder;
      },
      query: {
        properties: { findMany: async () => [] },
        entities: {
          findFirst: async () => {
            resourceLookups += 1;
            return undefined;
          },
        },
        legalLists: {
          findFirst: async () => {
            resourceLookups += 1;
            return undefined;
          },
        },
      },
      selectDistinctOn: () => {
        resourceLookups += 1;
        const query: unknown[] = [];
        return Object.assign(query, {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
        });
      },
      insert: () => ({ values: async () => [] }),
      update: () => {
        mutations += 1;
        return {
          set: () => ({
            where: () => ({ returning: async () => [{ id: resourceId }] }),
          }),
        };
      },
    };
    const database = createScopedDbMock(tx, {
      featureAccess: {
        identity: membership === "current" ? { email, emailVerified } : null,
      },
    });
    const context = createContext({
      scopedDb: database.scopedDb,
      safeDb: database.safeDb,
      workspaceIds: [matterId],
    });
    context.organizationId = toSafeId<"organization">(organizationId);
    context.userId = toSafeId<"user">(userId);
    context.userEmail = email;
    context.featureAccessSnapshot = createFeatureAccessSnapshot({
      organizationId,
      userId: context.userId,
      decisions: new Map(
        Object.keys(FEATURE_REGISTRY).map((featureId) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            grants: env.API_FEATURE_ACCESS_GRANTS,
            featureId,
            organizationId,
            userId: context.userId,
            user: { email, emailVerified },
            membership: membership === "current",
          }),
        ]),
      ),
    });
    return {
      context,
      resourceLookups: () => resourceLookups,
      mutations: () => mutations,
    };
  };

  test("the transport matrix covers every dedicated verification capability", () => {
    const declared = capabilityCatalog
      .filter(requiresVerificationGrant)
      .map(({ id }) => id);
    expect(Object.keys(inputs).toSorted()).toEqual(declared.toSorted());
  });

  test("empty grants omit dedicated verification capabilities from discovery", async () => {
    const { context } = verificationContext();
    const listed: string[] = [];
    for (const domain of ["lists"]) {
      const result = await handleMcpToolCall({
        toolName: "list_capabilities",
        context,
        args: { domain, limit: MAX_LIST_LIMIT },
      });
      listed.push(
        ...parseToolPayload<{ items: { id: string }[] }>(result).items.map(
          ({ id }) => id,
        ),
      );
    }
    for (const capability of Object.keys(inputs)) {
      expect(listed).not.toContain(capability);
      const described = await handleMcpToolCall({
        toolName: "describe_capability",
        context,
        args: { capability },
      });
      expect(errorEnvelope(described)).toMatchObject({
        code: "not_found",
        message: `No capability with id "${capability}"`,
        hint: expect.any(String),
      });
    }
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("real native and resource discovery preserves shared surfaces for another member", async () => {
    grantCurrentMember();
    const granted = verificationContext().context;
    const denied = verificationContext({
      userId: "user_2",
      email: "another-member@example.test",
    }).context;
    const featureCapabilities = capabilityCatalog
      .filter(requiresVerificationGrant)
      .map(({ id }) => id);
    expect(featureCapabilities).toHaveLength(Object.keys(inputs).length);
    const enabledTools = await listMcpTools(
      granted,
      "default",
      granted.grantedScopes,
    );
    const hiddenTools = await listMcpTools(
      denied,
      "default",
      denied.grantedScopes,
    );
    expect(enabledTools.length).toBeGreaterThan(0);
    const featureTools = listStaticMcpToolDefinitions().filter(
      (tool) => tool.featureId === LIST_VERIFICATION_FEATURE_ID,
    );
    for (const { name } of featureTools) {
      expect(enabledTools.map((tool) => tool.name)).toContain(name);
    }
    const featureToolNames = new Set(featureTools.map(({ name }) => name));
    expect(hiddenTools.map(({ name }) => name).toSorted()).toEqual(
      enabledTools
        .filter(({ name }) => !featureToolNames.has(name))
        .map(({ name }) => name)
        .toSorted(),
    );
    const hiddenNativeSurface = JSON.stringify(hiddenTools);
    for (const id of featureCapabilities) {
      expect(hiddenNativeSurface).not.toContain(id);
    }
    let projectedLayouts = 0;
    for (const { id } of capabilityCatalog.filter(
      (entry) =>
        "featureId" in entry &&
        entry.featureId === LIST_VERIFICATION_FEATURE_ID &&
        "featureAccess" in entry &&
        entry.featureAccess === "conditional",
    )) {
      const enabled = await handleMcpToolCall({
        toolName: "describe_capability",
        context: granted,
        args: { capability: id },
      });
      const hidden = await handleMcpToolCall({
        toolName: "describe_capability",
        context: denied,
        args: { capability: id },
      });
      const fullSchema = JSON.stringify(parseToolPayload(enabled));
      const hiddenSchema = JSON.stringify(parseToolPayload(hidden));
      if (fullSchema.includes('"avt"')) {
        projectedLayouts += 1;
      }
      expect(hiddenSchema).not.toContain('"avt"');
      expect(hidden.isError).not.toBe(true);
    }
    expect(projectedLayouts).toBeGreaterThan(0);
    const enabledResources = listMcpResources("default", granted);
    const hiddenResources = listMcpResources("default", denied);
    expect(enabledResources.length).toBeGreaterThan(0);
    // The production feature declares capability endpoints; its shared static
    // references remain available and contain no dedicated capability names.
    expect(hiddenResources.map(({ uri }) => uri).toSorted()).toEqual(
      enabledResources.map(({ uri }) => uri).toSorted(),
    );
    for (const { uri } of hiddenResources) {
      const resource = await readMcpResource(uri, "default", denied);
      const text = JSON.stringify(resource);
      for (const id of featureCapabilities) {
        expect(text).not.toContain(id);
      }
    }
  });

  test("the real views list transport retains unavailable identities without layout details", async () => {
    grantCurrentMember();
    const view = {
      id: toSafeId<"workspaceView">(resourceId),
      workspaceId: toSafeId<"workspace">(matterId),
      name: "Verification view",
      position: 0,
      createdAt: new Date("2026-10-02T10:00:00Z"),
      layout: {
        type: "avt",
        version: 1,
        listId: null,
        filters: [],
        sorts: [],
        hiddenProperties: [],
        calculations: [],
      },
    } satisfies typeof workspaceViews.$inferSelect;
    const listedCapability = capabilityCatalog.find(
      ({ id }) => id === "views.list",
    );
    expect(listedCapability).toMatchObject({
      featureId: LIST_VERIFICATION_FEATURE_ID,
      featureAccess: "conditional",
    });
    for (const caller of [
      {},
      { userId: "user_2", email: "another-member@example.test" },
    ]) {
      const fixture = verificationContext({ ...caller, viewRows: [view] });
      const result = await handleCapabilityCall({
        context: fixture.context,
        args: { capability: "views.list", input: { params: { matterId } } },
      });
      expect(result.isError).not.toBe(true);
      const payload = parseToolPayload<unknown[]>(result);
      expect(payload).toEqual(
        caller.userId === undefined
          ? [
              {
                version: 1,
                id: view.id,
                name: view.name,
                position: view.position,
                createdAt: view.createdAt.toISOString(),
                layout: view.layout,
              },
            ]
          : [
              {
                id: view.id,
                eligibility: "unavailable",
              },
            ],
      );
    }
    env.API_FEATURE_ACCESS_GRANTS = {};
    const denied = await handleCapabilityCall({
      context: verificationContext({ viewRows: [view] }).context,
      args: { capability: "views.list", input: { params: { matterId } } },
    });
    expect(denied.isError).not.toBe(true);
    expect(parseToolPayload<unknown[]>(denied)).toEqual([
      { id: view.id, eligibility: "unavailable" },
    ]);
  });

  test("empty grants deny invoke and validate-only before resource lookup or mutation", async () => {
    const fixture = verificationContext();
    for (const [capability, input] of Object.entries(inputs)) {
      for (const validate_only of [false, true]) {
        const result = await handleCapabilityCall({
          context: fixture.context,
          args: { capability, input, validate_only },
        });
        expect(errorEnvelope(result)).toMatchObject({
          code: "not_found",
          message: `No capability with id "${capability}"`,
          hint: expect.any(String),
        });
      }
    }
    expect(fixture.resourceLookups()).toBe(0);
    expect(fixture.mutations()).toBe(0);
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
    expect(consumeRateLimitMock).not.toHaveBeenCalled();
  });

  test("member grants advertise and validate every dedicated verification capability", async () => {
    grantCurrentMember();
    const fixture = verificationContext();
    const listed: string[] = [];
    for (const domain of ["lists"]) {
      const result = await handleMcpToolCall({
        toolName: "list_capabilities",
        context: fixture.context,
        args: { domain, limit: MAX_LIST_LIMIT },
      });
      listed.push(
        ...parseToolPayload<{ items: { id: string }[] }>(result).items.map(
          ({ id }) => id,
        ),
      );
    }
    for (const [capability, input] of Object.entries(inputs)) {
      expect(listed).toContain(capability);
      const described = await handleMcpToolCall({
        toolName: "describe_capability",
        context: fixture.context,
        args: { capability },
      });
      expect(described.isError).not.toBe(true);
      const result = await handleCapabilityCall({
        context: fixture.context,
        args: { capability, input, validate_only: true },
      });
      expect(
        parseToolPayload<{ valid: boolean; capability: string }>(result),
      ).toEqual({ valid: true, capability });
    }
    expect(fixture.resourceLookups()).toBeGreaterThan(0);
    expect(fixture.mutations()).toBe(0);
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("MCP resolves current verified identity, membership, and organization for each grant", async () => {
    grantCurrentMember();
    for (const options of [
      { email: "changed@example.test" },
      { userId: "user_2", email: "another-member@example.test" },
      { emailVerified: false },
      { membership: "departed" },
      { organizationId: "org_2" },
    ] as const satisfies readonly VerificationContextOptions[]) {
      const fixture = verificationContext(options);
      const listed = await handleMcpToolCall({
        toolName: "list_capabilities",
        context: fixture.context,
        args: { domain: "lists", limit: MAX_LIST_LIMIT },
      });
      const ids = parseToolPayload<{ items: { id: string }[] }>(
        listed,
      ).items.map(({ id }) => id);
      for (const [capability, input] of Object.entries(inputs)) {
        expect(ids).not.toContain(capability);
        const described = await handleMcpToolCall({
          toolName: "describe_capability",
          context: fixture.context,
          args: { capability },
        });
        expect(errorEnvelope(described)).toMatchObject({
          code: "not_found",
          message: `No capability with id "${capability}"`,
          hint: expect.any(String),
        });
        for (const validate_only of [false, true]) {
          const invoked = await handleCapabilityCall({
            context: fixture.context,
            args: { capability, input, validate_only },
          });
          expect(errorEnvelope(invoked)).toMatchObject({
            code: "not_found",
            message: `No capability with id "${capability}"`,
            hint: expect.any(String),
          });
        }
      }
      expect(fixture.resourceLookups()).toBe(0);
      expect(fixture.mutations()).toBe(0);
    }
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
    expect(consumeRateLimitMock).not.toHaveBeenCalled();
  });

  test("granted invocations reach their resource operations without model dispatch", async () => {
    grantCurrentMember();
    for (const [capability, input] of Object.entries(inputs)) {
      const fixture = verificationContext();
      const result = await handleCapabilityCall({
        context: fixture.context,
        args: { capability, input },
      });
      if (capability === "lists.items.sources.verification.update") {
        expect(result.isError).not.toBe(true);
        expect(parseToolPayload<{ id: string }>(result)).toEqual({
          id: resourceId,
        });
        expect(fixture.mutations()).toBe(1);
        continue;
      }
      expect(fixture.resourceLookups()).toBeGreaterThan(0);
      expect(fixture.mutations()).toBe(0);
      if (capability === "lists.verifications.list") {
        expect(result.isError).not.toBe(true);
        expect(parseToolPayload<{ items: unknown[] }>(result)).toMatchObject({
          items: [],
        });
      } else if (capability === "lists.verifications.latest.list") {
        expect(result.isError).not.toBe(true);
        expect(parseToolPayload<{ runs: unknown[] }>(result)).toEqual({
          runs: [],
        });
      } else {
        expect(errorEnvelope(result).code).toBe("not_found");
        expect(errorEnvelope(result).message).toContain("not found");
        expect(errorEnvelope(result).message).not.toBe("Not found");
      }
    }
  });
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

describe("capability handler refusal metadata", () => {
  test("every refusal projection uses a closed envelope code and preserves domain issues", () => {
    const domainCodes = Object.values(PLAYBOOK_RUN_FAILURE_CODE);
    for (const code of domainCodes) {
      expect(MCP_ERROR_CODES).not.toContain(code);
    }
    for (const status of [
      0, 200, 400, 401, 402, 403, 404, 409, 413, 422, 429, 500, 502, 503, 999,
    ]) {
      for (const code of [
        undefined,
        ...MCP_ERROR_CODES,
        ...domainCodes,
        "handler_specific_code",
      ]) {
        const message = "Correct the request";
        const issue = { path: "input.name", message: "Choose a valid name" };
        const projected = projectMcpRefusal({
          status,
          code,
          message,
          issues: [issue],
          hint: "Correct the request and call again.",
          retryable: false,
        });
        expect(MCP_ERROR_CODES).toContain(projected.code);
        expect(projected.issues).toContainEqual(issue);
        expect(projected.hint).toBe("Correct the request and call again.");
        expect(projected.retryable).toBe(false);
        if (
          code !== undefined &&
          !MCP_ERROR_CODES.some((candidate) => candidate === code)
        ) {
          expect(projected.issues).toContainEqual({ path: "", code, message });
        }
      }
    }
  });
  test("properties.update forwards the file type refusal's corrective action", async () => {
    const matterId = "00000000-0000-4000-8000-0000000a0001";
    const propertyId = "00000000-0000-4000-8000-0000000b0001";
    let writes = 0;
    const { safeDb, scopedDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [
              {
                id: toSafeId<"property">(propertyId),
                name: "Documents",
                content: { version: 1, type: "file" },
                tool: { version: 1, type: "manual-input" },
                system: false,
                kinds: ["document"],
                role: null,
                status: "fresh",
                playbookSourceId: null,
              },
            ],
          }),
        }),
      }),
      update: () => {
        writes += 1;
      },
    });
    const result = await handleCapabilityCall({
      context: createContext({ safeDb, scopedDb, workspaceIds: [matterId] }),
      args: {
        capability: "properties.update",
        input: {
          params: { matterId, propertyId },
          body: {
            name: "Notes",
            content: { version: 1, type: "text" },
            tool: { version: 1, type: "manual-input" },
          },
        },
      },
    });

    const error = errorEnvelope(result);
    expect(error).toMatchObject({
      code: "validation_error",
      message:
        "File property types cannot be changed. Keep the existing type; create a custom property for other values.",
      hint: "Keep the existing content.type in properties.update, or use properties.create to add a custom property with another type.",
      retryable: false,
    });
    expect(error.code).not.toBe(FILE_PROPERTY_TYPE_IMMUTABLE_CODE);
    expect(error.issues).toEqual([
      {
        path: "",
        code: FILE_PROPERTY_TYPE_IMMUTABLE_CODE,
        message: error.message,
      },
    ]);
    expect(writes).toBe(0);
  });

  test("time-entries.me.list forwards its invalid cursor corrective action", async () => {
    const result = await handleCapabilityCall({
      context: createContext(),
      args: {
        capability: "time-entries.me.list",
        input: {
          query: {
            date: "2026-10-01",
            cursor: encodePaginationCursor(["non-uuid"]),
          },
        },
      },
    });

    expect(errorEnvelope(result)).toMatchObject({
      code: "validation_error",
      message: "Invalid cursor",
      hint: "Restart the list without a cursor.",
    });
  });

  test.each([400, 401, 402, 403, 404, 409, 413, 422, 429])(
    "status %i forwards typed hint and both retryability values",
    (status) => {
      for (const retryable of [false, true]) {
        expect(
          mappedError(
            mapHandlerResult({
              id: "properties.update",
              access: "write",
              result: new ElysiaCustomStatusResponse(status, {
                code: "handler_specific_code",
                message: "A corrective action is required",
                hint: "Correct the matter and invoke the capability again.",
                retryable,
                issues: [
                  {
                    path: "input.name",
                    code: "invalid_name",
                    message: "Choose a valid name",
                  },
                ],
              }),
            }),
          ),
        ).toMatchObject({
          hint: "Correct the matter and invoke the capability again.",
          retryable,
          issues: [
            {
              path: "",
              code: "handler_specific_code",
              message: "A corrective action is required",
            },
            {
              path: "input.name",
              code: "invalid_name",
              message: "Choose a valid name",
            },
          ],
        });
      }
    },
  );

  test("malformed response metadata is omitted", () => {
    const error = mappedError(
      mapHandlerResult({
        id: "properties.update",
        access: "write",
        result: new ElysiaCustomStatusResponse(422, {
          message: "Invalid input",
          hint: { raw: "private details" },
          retryable: "false",
          issues: [{ path: 123, message: "Invalid shape" }],
        }),
      }),
    );
    expect(error).not.toHaveProperty("hint");
    expect(error).not.toHaveProperty("retryable");
    expect(error).not.toHaveProperty("issues");
  });
});

describe("documents.compare capability contract", () => {
  const MATTER_ID = "11111111-1111-4111-8111-111111111111";
  const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
  const BASE_VERSION_ID = "33333333-3333-4333-8333-333333333333";
  const TARGET_VERSION_ID = "44444444-4444-4444-8444-444444444444";

  const invokeValidation = async (selection: Record<string, unknown>) =>
    await handleCapabilityCall({
      args: {
        capability: "documents.compare",
        input: {
          params: { matterId: MATTER_ID, documentId: DOCUMENT_ID },
          body: {
            filePropertyId: "55555555-5555-4555-8555-555555555555",
            selection,
            mode: "strict",
            granularity: "word",
            baseTrackedChanges: "keep",
            targetTrackedChanges: "accept",
            output: { type: "version" },
          },
        },
        validate_only: true,
      },
      context: createContext({
        grantedScopes: ["stella:documents_write"],
        scopedDb: visibleReferenceDatabase([
          DOCUMENT_ID,
          "55555555-5555-4555-8555-555555555555",
          BASE_VERSION_ID,
          TARGET_VERSION_ID,
        ]).scopedDb,
        workspaceIds: [MATTER_ID],
      }),
    });

  test("list, describe, and invoke share its scope and selection union", async () => {
    const listed = await call("list_capabilities", {
      domain: "documents",
      limit: 50,
    });
    const listedPayload = parseToolPayload<{
      items: { id: string; scope: string; access: string }[];
    }>(listed);
    expect(listedPayload.items).toContainEqual(
      expect.objectContaining({
        id: "documents.compare",
        scope: "stella:documents_write",
        access: "write",
      }),
    );

    const described = await call("describe_capability", {
      capability: "documents.compare",
    });
    const describedPayload = parseToolPayload<{
      id: string;
      scope: string;
      handlerKind: string;
      disposition: { type: string; name?: string };
      inputSchema: {
        body?: {
          properties?: {
            output?: { anyOf?: Record<string, unknown>[] };
            selection?: { anyOf?: Record<string, unknown>[] };
          };
        };
      };
    }>(described);
    // The endpoint now backs the curated compare_documents tool. It stays in
    // the catalog and stays generically invocable, the way every other
    // tool-backed capability does; the disposition is what tells an agent that
    // reached it here to call the tool instead.
    expect(describedPayload).toMatchObject({
      id: "documents.compare",
      scope: "stella:documents_write",
      handlerKind: "workspace",
      disposition: { type: "tool", name: "compare_documents" },
    });
    const variants =
      describedPayload.inputSchema.body?.properties?.selection?.anyOf;
    expect(variants).toHaveLength(2);
    expect(variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: ["type", "baseVersionId", "targetVersionIds"],
          properties: expect.objectContaining({
            type: expect.objectContaining({ const: "versions" }),
            targetVersionIds: expect.objectContaining({
              minItems: 1,
              maxItems: 8,
            }),
          }),
        }),
        expect.objectContaining({
          required: ["type", "targetVersionId"],
          properties: expect.objectContaining({
            type: expect.objectContaining({ const: "previous" }),
          }),
        }),
      ]),
    );
    expect(
      describedPayload.inputSchema.body?.properties?.output?.anyOf,
    ).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          type: expect.objectContaining({ const: "preview" }),
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          type: expect.objectContaining({ const: "download" }),
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          type: expect.objectContaining({ const: "version" }),
        }),
      }),
    ]);

    const results = await Promise.all([
      invokeValidation({
        type: "versions",
        baseVersionId: BASE_VERSION_ID,
        targetVersionIds: [TARGET_VERSION_ID],
      }),
      invokeValidation({
        type: "previous",
        targetVersionId: TARGET_VERSION_ID,
      }),
    ]);
    for (const result of results) {
      expect(
        parseToolPayload<{ valid: boolean; capability: string }>(result),
      ).toEqual({ valid: true, capability: "documents.compare" });
    }
  });

  test("rejects a one-to-many selection above the advertised target bound", async () => {
    const result = await invokeValidation({
      type: "versions",
      baseVersionId: BASE_VERSION_ID,
      targetVersionIds: Array.from(
        { length: 9 },
        (_, index) =>
          `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      ),
    });

    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(
      issues.some(({ path }) => path === "body.selection.targetVersionIds"),
    ).toBe(true);
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

// --- capability executor: gates -----------------------------------------------

describe("capability executor gates", () => {
  test("unknown id -> not_found with closest-id hint", async () => {
    const result = await callCapability({
      capability: "time-entries.creat",
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("time-entries.create");
    // A mistyped capability is a caller error: the gate rejects it without
    // spending an exception event.
    expect(analytics.exceptions()).toEqual([]);
  });

  test("token/public capabilities are not invokable", async () => {
    // No token/public capability exists in the catalog today; assert the guard
    // by confirming the catalog holds only workspace/root kinds (defensive).
    const kinds = new Set(capabilityCatalog.map((e) => e.handlerKind));
    expect([...kinds].toSorted()).toEqual(["root", "workspace"]);
  });

  test("waived capability -> feature_disabled", async () => {
    const result = await handleCapabilityCall({
      args: { capability: "billing-codes.create", input: { body: {} } },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("test-only waiver");
  });

  test("missing scope -> missing_scope", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "X" } },
      },
      context: createContext({ grantedScopes: ["stella:read"] }),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("missing_scope");
    expect(error.message).toContain("stella:knowledge_write");
    expect(analytics.exceptions()).toEqual([]);
  });

  test("compound capability scope rejects a document-only grant", async () => {
    const result = await handleCapabilityCall({
      args: { capability: "templates.fills.create", input: {} },
      context: createContext({
        grantedScopes: ["stella:read", "stella:documents_write"],
      }),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("missing_scope");
    expect(error.message).toContain("stella:templates");
    expect(error.hint).toContain(
      "--scopes stella:read,stella:documents_write,stella:templates",
    );
  });

  test("documents mode reaches the canonical entity-version reservation with its advertised scopes", async () => {
    const result = await handleCapabilityCall({
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
          params: { matterId: "ws_1" },
        },
        validate_only: true,
      },
      context: createContext({
        scopedDb: visibleReferenceDatabase([
          "00000000-0000-4000-8000-000000000001",
        ]).scopedDb,
        grantedScopes: [
          "stella:read",
          "stella:documents_write",
          "stella:matters_write",
        ],
      }),
      mode: "documents",
    });

    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "uploads.create",
    });
  });

  // Scope-gate outcome for a read capability under a given granted-scope set.
  // validate_only stops after the scope + destructive gates, so the result is
  // never the handler's DB execution: it is `missing_scope` when the gate
  // rejects, and anything else (validation payload / validation_error) when the
  // gate is satisfied.
  const scopeGateCode = async (
    capability: string,
    grantedScopes: readonly string[],
  ): Promise<string> => {
    const result = await handleCapabilityCall({
      args: { capability, input: {}, validate_only: true },
      context: createContext({ grantedScopes }),
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
    const result = await callCapability({
      capability: "clauses.categories.delete",
      input: { params: { categoryId: "a1111111-1111-4111-8111-111111111111" } },
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("confirmation_required");
  });

  describe("sessions without a person to confirm (agent runs)", () => {
    const agentRunCall = async (args: Record<string, unknown>) =>
      await handleCapabilityCall({
        args,
        context: createContext({
          grantedScopes: MCP_OAUTH_SCOPES,
          toolConfirmation: TOOL_CONFIRMATION.unavailable,
        }),
      });

    test("every destructive capability is unavailable, even with confirm", async () => {
      // Derived from the catalog, not a list: a capability that later becomes
      // destructive is covered without touching this test.
      const destructiveIds = capabilityCatalog
        .filter(
          (entry) => entry.destructive && !requiresVerificationGrant(entry),
        )
        .map((entry) => entry.id);
      expect(destructiveIds.length).toBeGreaterThan(0);

      for (const capability of destructiveIds) {
        const result = await agentRunCall({
          capability,
          input: {},
          confirm: true,
        });
        expect({ capability, code: errorEnvelope(result).code }).toEqual({
          capability,
          code: "permission_denied",
        });
      }
    });

    test("destructive capabilities are not listed", async () => {
      type CapabilityPage = {
        items: { id: string; destructive: boolean }[];
        nextCursor: string | null;
      };
      const listed: CapabilityPage["items"] = [];
      let cursor: string | null = null;
      do {
        const page: CapabilityPage = parseToolPayload<CapabilityPage>(
          await handleMcpToolCall({
            args: {
              limit: MAX_LIST_LIMIT,
              ...(cursor === null ? {} : { cursor }),
            },
            context: createContext({
              grantedScopes: MCP_OAUTH_SCOPES,
              toolConfirmation: TOOL_CONFIRMATION.unavailable,
            }),
            toolName: "list_capabilities",
          }),
        );
        listed.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(listed.length).toBeGreaterThan(0);
      expect(listed.filter(({ destructive }) => destructive)).toEqual([]);
    });

    test("a capability that needs no confirmation is unaffected", async () => {
      const result = await agentRunCall({
        capability: "entities.get",
        input: {},
        validate_only: true,
      });
      const payload = parseToolPayload(result);
      const code =
        typeof payload === "object" && payload !== null && "error" in payload
          ? asTestRaw<{ error: { code: string } }>(payload).error.code
          : "ok";
      expect(code).not.toBe("permission_denied");
    });
  });

  test("invalid input -> validation_error with dot-path issues", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" }, query: { status: "bogus" } },
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "query.status")).toBe(true);
  });

  test("validate_only returns without executing", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "Draft category" } },
        validate_only: true,
      },
      context: createContext(),
    });
    // Text and structuredContent are one `{ result }` envelope.
    expect(modelViewOf(result)).toEqual({
      result: { valid: true, capability: "clauses.categories.create" },
    });
    // No handler executed, so the org-settings loader was never consulted.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- capability executor: the container's public name --------------------------

// The rename is a clean cutover: `matterId` is the only spelling the wire
// accepts, and every issue an agent reads back names the field it was shown.
describe("capability executor names the container matterId", () => {
  const UUID = "44444444-4444-4444-8444-444444444444";

  const invokeIssues = async (
    args: Record<string, unknown>,
  ): Promise<{ path: string; message: string }[]> => {
    const result = await handleCapabilityCall({
      args,
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    return asTestRaw<{ path: string; message: string }[]>(error.issues ?? []);
  };

  test("the internal spelling alone is refused, not silently accepted", async () => {
    const issues = await invokeIssues({
      capability: "time-entries.csv.export",
      input: { params: { workspaceId: "ws_1" } },
    });
    expect(issues).toEqual([
      {
        path: "params.matterId",
        message: "workspaceId is the internal name for matterId; send matterId",
      },
    ]);
    // Refused before anything ran: no handler, no workspace resolution.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("both spellings are refused rather than letting key order decide", async () => {
    // Whichever way the JSON is ordered, the answer is the same refusal --
    // never "the last key wins".
    for (const params of [
      { matterId: "ws_1", workspaceId: "ws_2" },
      { workspaceId: "ws_2", matterId: "ws_1" },
    ]) {
      const issues = await invokeIssues({
        capability: "time-entries.csv.export",
        input: { params },
      });
      expect(issues.map((issue) => issue.path)).toEqual(["params.matterId"]);
    }
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("a nested internal spelling is refused at its own path", async () => {
    // signals.acceptances.create carries the container inside body.result, so
    // the refusal has to reach past the top level of the part.
    const issues = await invokeIssues({
      capability: "signals.acceptances.create",
      input: {
        params: { signalId: UUID },
        body: {
          suggestionKind: "promote-to-workspace",
          result: { type: "workspace", workspaceId: UUID },
        },
      },
    });
    expect(issues.map((issue) => issue.path)).toEqual(["body.result.matterId"]);
  });

  test("a validation issue on the container names matterId, not workspaceId", async () => {
    // Validation runs against the handler's own schema, which calls the field
    // workspaceId; the agent typed --matter-id and must be pointed there.
    const issues = await invokeIssues({
      capability: "entities.get",
      input: { params: { matterId: "not-a-uuid", entityId: UUID } },
    });
    expect(issues.map((issue) => issue.path)).toContain("params.matterId");
    expect(issues.some((issue) => issue.path.includes("workspaceId"))).toBe(
      false,
    );
  });
});

// --- capability executor: discriminated-union input errors --------------------

// Guards the "path-less union error" class: a failed discriminated union must
// name its discriminator field (and, once the discriminator matches a variant,
// that variant's own missing fields), never collapse to an opaque, unplaceable
// `Expected union value`. uploads.create's body is a flat union keyed by
// `purpose`, so it is the canonical driver.
describe("discriminated-union input validation names the field", () => {
  const uploadIssues = async (
    body: unknown,
  ): Promise<{ path: string; message: string }[]> => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.create",
        input: { params: { matterId: "ws_1" }, body },
      },
      context: createContext(),
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
      const issues = await uploadIssues(body);
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.path.length).toBeGreaterThan(0);
      }
    }
  });
});

// --- capability executor: workspace resolution --------------------------------

describe("capability executor workspace resolution", () => {
  test("inaccessible workspace -> not_found", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_nope" } },
      },
      context: createContext(),
    });
    expect(errorEnvelope(result).code).toBe("not_found");
  });

  test("archived workspace on a READ capability -> not_found (REST parity)", async () => {
    // validateWorkspaceAccess (lib/auth.ts) 404s ANY non-active workspace,
    // reads included; the generic path must be no weaker.
    const pinnedWorkspaceIds: string[] = [];
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_arch" } },
      },
      context: createContext({
        workspaceIds: ["ws_arch"],
        archivedWorkspaceIds: ["ws_arch"],
        pinServerValidatedWorkspaceId: (workspaceId) => {
          pinnedWorkspaceIds.push(workspaceId);
          return true;
        },
      }),
    });
    expect(errorEnvelope(result).code).toBe("not_found");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
    expect(pinnedWorkspaceIds).toEqual([]);
  });

  test("archived workspace on a write capability -> not_found", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "case-law.matter-links.create",
        input: {
          body: { decisionId: "00000000-0000-0000-0000-000000000000" },
          params: { matterId: "ws_arch" },
        },
      },
      context: createContext({
        workspaceIds: ["ws_arch"],
        archivedWorkspaceIds: ["ws_arch"],
      }),
    });
    expect(errorEnvelope(result).code).toBe("not_found");
  });

  test("pins an active workspace only after capability access validation", async () => {
    const pinnedWorkspaceIds: string[] = [];
    const result = await handleCapabilityCall({
      args: {
        capability: "case-law.matter-links.create",
        input: {
          body: { decisionId: "00000000-0000-0000-0000-000000000000" },
          params: { matterId: "ws_1" },
        },
        validate_only: true,
      },
      context: createContext({
        pinServerValidatedWorkspaceId: (workspaceId) => {
          pinnedWorkspaceIds.push(workspaceId);
          return true;
        },
      }),
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
      capabilityId: "entities.copy",
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
      capabilityId: "entities.copy",
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
      capabilityId: "entities.copy",
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

// --- capability executor: end-to-end execution --------------------------------

describe("capability executor execution", () => {
  test("runs a read capability end-to-end (workspace-resolved)", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
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
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "Test Category" } },
      },
      context: createContext({ safeDb, scopedDb }),
    });
    expect(
      parseToolPayload<{ id: string; name: string }>(result),
    ).toMatchObject({
      id: "cc_1",
      name: "Test Category",
    });
  });

  test("destructive write dispatch requires confirmation", async () => {
    const categoryId = "a1111111-1111-4111-8111-111111111111";
    const deleteRow = mock(async () => undefined);
    const updateRow = mock(async () => undefined);
    const auditRows = mock(async () => undefined);
    const findCategory = mock(async () => ({
      id: categoryId,
      name: "Synthetic Category",
      parentId: null,
    }));
    const { safeDb, scopedDb } = createScopedDbMock({
      query: { clauseCategories: { findFirst: findCategory } },
      update: () => ({ set: () => ({ where: updateRow }) }),
      delete: () => ({ where: deleteRow }),
      insert: () => ({ values: auditRows }),
    });
    const context = createContext({ safeDb, scopedDb });
    const args = {
      capability: "clauses.categories.delete",
      input: { params: { categoryId } },
    };
    const unconfirmed = await handleMcpToolCall({
      toolName: MCP_CAPABILITY_EXECUTORS.write,
      args,
      context,
    });
    expect(errorEnvelope(unconfirmed).code).toBe("confirmation_required");
    expect(findCategory).not.toHaveBeenCalled();
    expect(deleteRow).not.toHaveBeenCalled();
    expect(auditRows).not.toHaveBeenCalled();

    const confirmed = await handleMcpToolCall({
      toolName: MCP_CAPABILITY_EXECUTORS.write,
      args: { ...args, confirm: true },
      context,
    });
    expect(confirmed.isError).not.toBe(true);
    const payload = parseToolPayload(confirmed);
    expect(payload).toEqual({});
    expect(findCategory).toHaveBeenCalledTimes(1);
    expect(updateRow).toHaveBeenCalledTimes(1);
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(auditRows).toHaveBeenCalledTimes(1);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("a role without permission -> permission_denied", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "X" } },
      },
      context: createContext({ memberRole: "intern" }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });
});

describe("capability executor upload purpose gate", () => {
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
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { matterId: "ws_1" } },
        validate_only: true,
      },
      context: createContext({ grantedScopes: ["stella:matters_write"] }),
    });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe("missing_scope");
    expect(envelope.message).toContain("stella:skills");
  });

  test("the skills consent admits the same call", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { matterId: "ws_1" } },
        validate_only: true,
      },
      context: createContext({
        grantedScopes: ["stella:matters_write", "stella:skills"],
      }),
    });
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });

  test("a document upload needs the documents consent, not the domain scope alone", async () => {
    const invoke = async (grantedScopes: string[]) =>
      await handleCapabilityCall({
        args: {
          capability: "uploads.create",
          input: { body: documentBody, params: { matterId: "ws_1" } },
          validate_only: true,
        },
        context: createContext({ grantedScopes }),
      });

    const refused = errorEnvelope(await invoke(["stella:matters_write"]));
    expect(refused.code).toBe("missing_scope");
    expect(refused.message).toContain("stella:documents_write");
    expect(
      parseToolPayload<{ valid: boolean }>(
        await invoke(["stella:matters_write", "stella:documents_write"]),
      ).valid,
    ).toBe(true);
  });

  test("finalize takes the purpose from the stored upload, not from the caller", async () => {
    // The finalize call names only an upload id, so the consent it must hold is
    // the one its recorded purpose spends.
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.update",
        input: { params: { matterId: WORKSPACE_ID, uploadId: UPLOAD_ID } },
        validate_only: true,
      },
      context: createContext({
        grantedScopes: ["stella:matters_write"],
        workspaceIds: [WORKSPACE_ID],
        scopedDb: storedPurposeDb("agent_skill"),
      }),
    });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe("missing_scope");
    expect(envelope.message).toContain("stella:skills");
  });

  test("finalizing a document upload needs the documents consent", async () => {
    const invoke = async (grantedScopes: string[]) =>
      await handleCapabilityCall({
        args: {
          capability: "uploads.update",
          input: { params: { matterId: WORKSPACE_ID, uploadId: UPLOAD_ID } },
          validate_only: true,
        },
        context: createContext({
          grantedScopes,
          workspaceIds: [WORKSPACE_ID],
          scopedDb: storedPurposeDb("entity_create"),
        }),
      });

    const refused = errorEnvelope(await invoke(["stella:matters_write"]));
    expect(refused.code).toBe("missing_scope");
    expect(refused.message).toContain("stella:documents_write");
    expect(
      parseToolPayload<{ valid: boolean }>(
        await invoke(["stella:matters_write", "stella:documents_write"]),
      ).valid,
    ).toBe(true);
  });

  // The permission half of the same gate. `uploads.*` declares workspace:read
  // in its config because the grant a call actually spends is only known once
  // its purpose is; the handler re-derives that grant from the member role, so
  // the dispatch path is where a credential's own set is ANDed into it.
  test("a purpose the role does not grant -> permission_denied", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { matterId: "ws_1" } },
        validate_only: true,
      },
      // intern holds workspace:read (the config gate) but no agentSkill grant.
      context: createContext({
        grantedScopes: ["stella:matters_write", "stella:skills"],
        memberRole: "intern",
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("a purpose the credential set does not cover -> permission_denied", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { matterId: "ws_1" } },
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
        grantedScopes: ["stella:matters_write", "stella:skills"],
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("a credential set covering the purpose admits the same call", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.create",
        input: { body: skillPackBody, params: { matterId: "ws_1" } },
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: {
          agentSkill: ["create"],
          workspace: ["read"],
        },
        grantedScopes: ["stella:matters_write", "stella:skills"],
      }),
    });
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });

  test("finalize spends the stored purpose's permission", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.update",
        input: { params: { matterId: WORKSPACE_ID, uploadId: UPLOAD_ID } },
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
        grantedScopes: ["stella:matters_write", "stella:skills"],
        workspaceIds: [WORKSPACE_ID],
        scopedDb: storedPurposeDb("agent_skill"),
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("abort spends it too, though it stays on the domain scope", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "uploads.delete",
        confirm: true,
        input: { params: { matterId: WORKSPACE_ID, uploadId: UPLOAD_ID } },
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
        grantedScopes: ["stella:matters_write"],
        workspaceIds: [WORKSPACE_ID],
        scopedDb: storedPurposeDb("entity_create"),
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("every uploads capability is covered by the purpose gate", () => {
    // The gate is keyed by capability id, so a new `uploads.*` capability that
    // ran its purpose check in the handler alone would be invisible here.
    const uploadCapabilityIds = capabilityCatalog
      .filter((entry) => entry.id.startsWith("uploads."))
      .map((entry) => entry.id);

    expect(uploadCapabilityIds.length).toBeGreaterThan(0);
    expect([...UPLOAD_PURPOSE_GATE_BY_CAPABILITY.keys()].toSorted()).toEqual(
      uploadCapabilityIds.toSorted(),
    );
  });
});

describe("capability executor credential permission set", () => {
  test("a credential set that does not cover the capability -> permission_denied", async () => {
    // The role is owner, so the role half passes; the credential's own set does
    // not name `clause`, and authority is the AND of the two.
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "X" } },
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("an action the credential set omits on a resource it names -> permission_denied", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "X" } },
      },
      context: createContext({
        credentialPermissions: { clause: ["delete"] },
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("validate_only reports the same refusal as execution would", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "X" } },
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
      }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });

  test("a refused call consumes no rate-limit budget", async () => {
    // The budget bounds work that runs. Charging it before the authority check
    // would let a caller who may not perform the capability spend their window
    // on refusals.
    await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "X" } },
      },
      context: createContext({ memberRole: "intern" }),
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
    const result = await handleCapabilityCall({
      args: { capability: "case-law.ingestion.get" },
      context: createContext({ memberRole: "member" }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
  });
});

// --- validate_only enforces member permissions --------------------------------

describe("capability executor validate_only permission preflight", () => {
  test("a role lacking the permission -> permission_denied from validate_only", async () => {
    // case-law.ingestion.get is root-kind with auditLog:["read"] (owner/
    // admin only); validate_only must mirror the wrapper's gate, not report
    // valid: true for a call that would 403 at execution.
    const result = await handleCapabilityCall({
      args: { capability: "case-law.ingestion.get", validate_only: true },
      context: createContext({ memberRole: "member" }),
    });
    expect(errorEnvelope(result).code).toBe("permission_denied");
    // Preflight only: the handler never executed.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("a sufficient role still gets valid: true without executing", async () => {
    const result = await handleCapabilityCall({
      args: { capability: "case-law.ingestion.get", validate_only: true },
      context: createContext({ memberRole: "owner" }),
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({ valid: true, capability: "case-law.ingestion.get" });
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- fix-3: gateway rate limit ----------------------------------------------

describe("capability executor rate limit (fix-3)", () => {
  test("an exhausted budget -> rate_limited with a retry hint", async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      retryAfterSeconds: 60,
    });
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("rate_limited");
    expect(error.hint).toContain("60 seconds");
    // Refused before the handler ran: the org-settings loader was not consulted.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("the limiter is consulted per (organization, capability)", async () => {
    await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
    });
    expect(consumeRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityId: "time-entries.csv.export" }),
    );
  });
});

// --- fix-4: archived-workspace gate allows unarchive-shaped invokes ---------

describe("capability executor archived-workspace gate (fix-4)", () => {
  const archivedCtx = () =>
    createContext({
      workspaceIds: ["ws_arch"],
      archivedWorkspaceIds: ["ws_arch"],
    });

  test("an allowsArchivedWorkspace write passes the gate on an archived workspace", async () => {
    // validate_only reaches (and clears) the workspace gate without executing, so
    // this asserts the gate result independent of the unarchive DB work.
    const result = await handleCapabilityCall({
      args: {
        capability: "matters.unarchive",
        input: { params: { matterId: "ws_arch" } },
        validate_only: true,
      },
      context: archivedCtx(),
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "matters.unarchive",
    });
  });

  test("a normal write is still refused on an archived workspace", async () => {
    // case-law.matter-links.create is a workspace write without the
    // allowsArchivedWorkspace flag, and its only body field is a UUID (so input
    // validation passes and the archived-workspace gate is what refuses it).
    const result = await handleCapabilityCall({
      args: {
        capability: "case-law.matter-links.create",
        input: {
          params: { matterId: "ws_arch" },
          body: { decisionId: "00000000-0000-0000-0000-000000000000" },
        },
        validate_only: true,
      },
      context: archivedCtx(),
    });
    expect(errorEnvelope(result).code).toBe("not_found");
  });
});

// --- fix-5: validate_only runs workspace resolution first ---------------------

describe("capability executor validate_only ordering (fix-5)", () => {
  test("validate_only on a workspace capability fails when the workspace is missing", async () => {
    // time-entries.csv.export declares no params schema, so pre-fix validate_only
    // returned { valid: true } before any workspace check. Now resolution runs
    // first, so a missing workspaceId surfaces as it would on a real invoke.
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: {},
        validate_only: true,
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("validate_only succeeds once the workspace resolves, still without executing", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
        validate_only: true,
      },
      context: createContext(),
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "time-entries.csv.export",
    });
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- fix-6: file/stream capabilities refused --------------------------------

describe("capability executor file-response gate (fix-6)", () => {
  test("(layer a) a file-returning capability is refused pre-execution", async () => {
    const result = await handleCapabilityCall({
      args: { capability: "clauses.export" },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("file or stream");
    // Refused before dispatch: no handler ran.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("(layer a) a helper-built binary capability is refused pre-execution", async () => {
    // time-entries.pdf.export returns a Uint8Array (not a Response) via a
    // helper; the flag refuses it before dispatch.
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.pdf.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
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

  test("verification limit refusals preserve codes, recovery metadata and receipts", () => {
    for (const code of Object.values(VERIFICATION_RUN_CAP_CODES)) {
      for (const retryable of [true, false]) {
        const refusal = {
          code,
          message: "Verification run limit reached",
          hint: "Check verification runs before starting another run.",
          retryable,
        };
        const result = runWithRequestId("req_refusal", () =>
          mapHandlerResult({
            id: "documents.verifications.start",
            access: "write",
            result: new ElysiaCustomStatusResponse(429, refusal),
          }),
        );
        expect(mappedError(result)).toMatchObject({
          ...refusal,
          requestId: "req_refusal",
        });
      }
    }
  });

  test("admission refusals preserve the shared contract and request receipt", () => {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const hint = `${refusal.hint} Contact: https://example.invalid/contact`;
      const result = runWithRequestId("req_refusal", () =>
        mapHandlerResult({
          id: "x.y",
          access: "write",
          result: new ElysiaCustomStatusResponse(refusal.status, {
            code,
            message: refusal.message,
            hint,
          }),
        }),
      );
      expect(mappedError(result)).toEqual(
        expect.objectContaining({
          code,
          message: refusal.message,
          hint,
          retryable: refusal.retryable,
          requestId: "req_refusal",
        }),
      );
    }
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

describe("capability executor file-input gate", () => {
  test("template upload recovery names the dedicated MCP tool instead of the rejected capability", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "templates.create",
        input: { body: { file: "bytes", name: "Template" } },
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.hint).toContain("Call the create_template MCP tool directly");
    expect(error.hint).not.toContain("Use templates.create instead");
  });

  test("a required-file capability is refused pre-execution, naming its alternative", async () => {
    // entities.upload's body carries a required t.File(); JSON cannot deliver a
    // File, so the gate refuses before validation/dispatch — and the hint
    // carries the presigned flow's real capability ids from the catalog, so the
    // agent gets a next call instead of a dead end.
    const result = await handleCapabilityCall({
      args: {
        capability: "entities.upload",
        input: {
          params: { matterId: "ws_1" },
          body: { file: "not-a-file" },
        },
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("requires a file in `file`");
    expect(error.hint).toContain("uploads.create");
    expect(error.hint).toContain("uploads.update");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("validate_only is refused too (a string would falsely validate as a File)", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "entities.upload",
        input: {
          params: { matterId: "ws_1" },
          body: { file: "not-a-file" },
        },
        validate_only: true,
      },
      context: createContext(),
    });
    expect(errorEnvelope(result).code).toBe("feature_disabled");
  });

  test("an OPTIONAL file field leaves the capability invocable in its JSON modes", async () => {
    // templates.prefill takes `file`, `text`, and `entityIds` as alternative
    // sources; only the first needs bytes. The old boolean dropped the whole
    // capability from every client — this asserts the JSON modes now reach
    // dispatch (the handler runs; whatever it returns is beyond this gate).
    const result = await handleCapabilityCall({
      args: {
        capability: "templates.prefill",
        input: {
          params: { templateId: "01234567-89ab-cdef-0123-456789abcdef" },
          body: { text: "Tenant: ACME" },
        },
        validate_only: true,
      },
      context: createContext({ grantedScopes: ["stella:templates"] }),
    });
    // Reached validation: the input is accepted, not refused by a transport
    // gate. The old boolean returned `feature_disabled` here.
    expect(parseToolPayload<{ valid: boolean }>(result).valid).toBe(true);
  });

  test("the withheld file field is refused, not silently dropped", async () => {
    // A caller who sent bytes-as-a-string must not get a success computed from
    // the other sources: the string would pass `format: "binary"` validation
    // and reach a handler expecting a `File`.
    const result = await handleCapabilityCall({
      args: {
        capability: "templates.prefill",
        input: {
          params: { templateId: "01234567-89ab-cdef-0123-456789abcdef" },
          body: { file: "not-a-file", text: "Tenant: ACME" },
        },
      },
      context: createContext({ grantedScopes: ["stella:templates"] }),
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
    expect([...declaredFileInput].toSorted()).toEqual(
      [...schemaBinary].toSorted(),
    );
    for (const id of [
      "entities.upload",
      "clauses.import",
      "templates.create",
      "templates.prefill",
    ]) {
      expect(declaredFileInput.has(id), id).toBe(true);
    }
    expect(declaredFileInput.has("time-entries.csv.export")).toBe(false);
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

describe("capability executor argument shape validation", () => {
  test('validate_only: "true" (string) -> validation_error, capability NOT executed', async () => {
    // The transport does not enforce the advertised JSON Schema; a mistyped
    // dry-run flag silently read as false would EXECUTE the capability.
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: { name: "Dry run intended" } },
        validate_only: "true",
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "validate_only")).toBe(true);
    // Refused before any dispatch: the org-settings loader never ran.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test('confirm: "yes" (string) -> validation_error, not confirmation_required', async () => {
    const result = await handleCapabilityCall({
      args: { capability: "clauses.categories.delete", confirm: "yes" },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "confirm")).toBe(true);
  });

  test("non-object input -> validation_error", async () => {
    const result = await handleCapabilityCall({
      args: { capability: "clauses.categories.create", input: "not-an-object" },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "input")).toBe(true);
  });

  test("non-object input parts -> validation_error naming each part", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "clauses.categories.create",
        input: { body: "text body", params: 7 },
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "input.body")).toBe(true);
    expect(issues.some((i) => i.path === "input.params")).toBe(true);
  });

  test("sibling meta-tools normalize declared numbers but not ordinary strings", async () => {
    // list_capabilities shares the declared numeric normalization boundary.
    const list = await call("list_capabilities", { limit: "5" });
    expect(parseToolPayload<{ limit: number }>(list).limit).toBe(5);
    // Ordinary strings remain untouched: a numeric capability id is invalid.
    const described = await call("describe_capability", { capability: 42 });
    expect(errorEnvelope(described).code).toBe("validation_error");
  });

  test("an input part sent at the top level -> validation_error naming it", async () => {
    // Ignoring a misplaced `query` ran the capability with NO input: an agent
    // asking for one audit entry got the whole default page.
    const result = await handleCapabilityCall({
      args: { capability: "audit-logs.list", query: { limit: 1 } },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string; message: string }[]>(error.issues);
    expect(issues.find((i) => i.path === "query")?.message).toContain(
      "Unknown parameter: query",
    );
    expect(error.hint).toContain("input");
    // Refused before any dispatch: nothing ran with the dropped filter.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("an unknown key inside input -> validation_error naming it", async () => {
    // `readInvokeInput` keeps only body/params/query; a misspelt part would
    // otherwise run the capability without the filter the agent asked for.
    const result = await handleCapabilityCall({
      args: { capability: "audit-logs.list", input: { queries: { limit: 1 } } },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string; message: string }[]>(error.issues);
    expect(issues.find((i) => i.path === "input.queries")?.message).toContain(
      "body, params, query",
    );
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("every unknown top-level argument is named (no silent drop)", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "contacts.list",
        body: { q: "acme" },
        // The pre-rename spelling is an unknown argument now, not an alias.
        validateOnly: true,
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string; message: string }[]>(error.issues);
    expect(issues.map((i) => i.path).toSorted()).toEqual([
      "body",
      "validateOnly",
    ]);
    expect(issues.find((i) => i.path === "validateOnly")?.message).toContain(
      "validate_only",
    );
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

// --- advertised schema == enforced schema ------------------------------------

describe("capability executor enforces the advertised input schema", () => {
  // contacts.list advertises a bounded `query.limit`; describe_capability and
  // the invoke gate render it from the same projection, so the bound an agent
  // reads is the bound it hits.
  const CAPABILITY = "contacts.list";

  const advertisedLimit = async (): Promise<Record<string, unknown>> => {
    const described = await call("describe_capability", {
      capability: CAPABILITY,
    });
    const payload = parseToolPayload<{
      inputSchema: { query?: { properties?: Record<string, unknown> } };
    }>(described);
    const limit = payload.inputSchema.query?.properties?.["limit"];
    if (typeof limit !== "object" || limit === null) {
      throw new Error("Expected contacts.list to advertise query.limit");
    }
    return asTestRaw<Record<string, unknown>>(limit);
  };

  test("describe renders a bounded integer, not a coercion union", async () => {
    // Elysia's t.Integer compiles to a string|integer union with the bounds
    // hoisted above it; that shape is unreadable and unenforceable.
    expect(await advertisedLimit()).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
  });

  test("a value above the advertised maximum is refused, naming the path", async () => {
    const maximum = (await advertisedLimit())["maximum"];
    const result = await handleCapabilityCall({
      args: {
        capability: CAPABILITY,
        input: { query: { limit: Number(maximum) + 1 } },
        validate_only: true,
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("validation_error");
    const issues = asTestRaw<{ path: string }[]>(error.issues);
    expect(issues.some((i) => i.path === "query.limit")).toBe(true);
  });

  test("the advertised maximum itself validates, string form included", async () => {
    const maximum = Number((await advertisedLimit())["maximum"]);
    // The string form is what a REST caller sends; flattening the coercion
    // union must not cost the conversion the union was there for.
    const results = await Promise.all(
      [maximum, String(maximum)].map(
        async (limit) =>
          await handleCapabilityCall({
            args: {
              capability: CAPABILITY,
              input: { query: { limit } },
              validate_only: true,
            },
            context: createContext(),
          }),
      ),
    );
    for (const result of results) {
      expect(
        parseToolPayload<{ valid: boolean; capability: string }>(result),
      ).toEqual({ valid: true, capability: CAPABILITY });
    }
  });
});

// --- Shared agent-boundary input normalization --------------------------------

describe("capability executor input normalization", () => {
  test("unknown keys removed by the REST cleaner are rejected for agents", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "templates.lookup-formats.create",
        input: {
          body: {
            registry: "ares",
            name: "Company number",
            format: "{value}",
            unknownExtra: "would fail additionalProperties:false without Clean",
          },
        },
        validate_only: true,
      },
      context: createContext({ grantedScopes: ["stella:templates"] }),
    });
    expect(errorEnvelope(result)).toMatchObject({
      code: "validation_error",
      issues: [
        {
          path: "body.unknownExtra",
          message: "Unknown parameter: unknownExtra",
        },
      ],
    });
  });

  test("normalizes a declared date before strict capability validation", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "work-obligations.queues.list",
        input: { query: { asOf: "1. 10. 2026" } },
        validate_only: true,
      },
      context: createContext(),
    });
    expect(
      parseToolPayload<{ valid: boolean; capability: string }>(result),
    ).toEqual({
      valid: true,
      capability: "work-obligations.queues.list",
    });
  });

  test("returns a field-level clarification for an ambiguous date", async () => {
    const result = await handleCapabilityCall({
      args: {
        capability: "work-obligations.queues.list",
        input: { query: { asOf: "01/02/2026" } },
        validate_only: true,
      },
      context: createContext(),
    });
    expect(errorEnvelope(result)).toMatchObject({
      code: "validation_error",
      issues: [
        {
          path: "query.asOf",
          message: '"01/02/2026" is not a calendar date.',
        },
      ],
      hint: expect.stringContaining("2026-02-01"),
    });
  });

  test("workspaceId still resolves when the config params schema omits it", async () => {
    // The route macro owns workspaceId at REST; Clean must not break the
    // resolution for configs that do not declare it (raw-params read).
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
    });
    expect(parseToolPayload<string>(result)).toContain("Date,");
  });
});

// --- deployment feature gates -------------------------------------------------

describe("capability executor deployment feature gate", () => {
  test("a gated-off capability is refused on invoke with feature_disabled", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
    });
    const error = errorEnvelope(result);
    expect(error.code).toBe("feature_disabled");
    expect(error.message).toContain("not enabled on this deployment");
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });

  test("validate_only is refused too (the gate runs before everything)", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
        validate_only: true,
      },
      context: createContext(),
    });
    expect(errorEnvelope(result).code).toBe("feature_disabled");
  });

  test("describe_capability refuses a gated-off entry (no schema leak)", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    const result = await call("describe_capability", {
      capability: "time-entries.csv.export",
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
    const result = await handleCapabilityCall({
      args: {
        capability: "time-entries.csv.export",
        input: { params: { matterId: "ws_1" } },
      },
      context: createContext(),
    });
    expect(parseToolPayload<string>(result)).toContain("Date,");
  });

  test("discovery omits deployment-disabled and ungranted verification capabilities", async () => {
    disabledFeatures.add("FEATURE_TIME_BILLING");
    disabledFeatures.add("FEATURE_USAGE");
    const listed = new Set<string>();
    type CapabilityPage = {
      items: { id: string }[];
      nextCursor: string | null;
    };
    let cursor: string | null = null;
    do {
      const page: CapabilityPage = parseToolPayload(
        await call("list_capabilities", {
          limit: 50,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      for (const item of page.items) {
        listed.add(item.id);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    const hidden = capabilityCatalog
      .map((entry) => entry.id)
      .filter((id) => !listed.has(id))
      .toSorted();
    expect(hidden).toContain("usage.entitlement.get");
    const context = createContext();
    const disabledIds = await featureOmittedCapabilityIds(
      (feature) => feature === undefined || !disabledFeatures.has(feature),
      context,
    );
    const snapshot = context.featureAccessSnapshot;
    if (snapshot === undefined) {
      throw new Error("Expected caller feature admission fixture");
    }
    const ungrantedIds = capabilityCatalog
      .filter(
        (entry) =>
          entry.featureAccess === "required" &&
          !isFeatureEnabled(snapshot, entry.featureId, context),
      )
      .map(({ id }) => id);
    expect([...new Set([...disabledIds, ...ungrantedIds])].toSorted()).toEqual(
      hidden,
    );
  });

  test("describe exposes the feature flag on an enabled entry", async () => {
    const result = await call("describe_capability", {
      capability: "time-entries.csv.export",
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

describe("feature access discovery guard: real capability catalog", () => {
  const featureId = "fixture-access";
  const registry = { [featureId]: { enrolment: "invitation" } } as const;
  const bindings = {
    capabilities: new Map(capabilityCatalog.map(({ id }) => [id, featureId])),
    tools: new Map<string, string>(),
    resources: new Map<string, string>(),
  };
  const fixtureContext = (userId: string, organizationId: string) => {
    const context = createContext();
    context.userId = toSafeId<"user">(userId);
    context.organizationId = toSafeId<"organization">(organizationId);
    context.testDependencies = {
      ...context.testDependencies,
      featureAccessBindings: bindings,
      featureAccessSnapshot: createFeatureAccessSnapshot({
        organizationId,
        userId,
        decisions: new Map([
          [
            featureId,
            decideFeatureAccess({
              registry,
              grants: {
                [featureId]: [
                  {
                    type: "member",
                    organizationId: "org_1",
                    email: "invited@example.test",
                  },
                ],
              },
              featureId,
              organizationId,
              userId,
              user: {
                email:
                  userId === "user_1"
                    ? "invited@example.test"
                    : "colleague@example.test",
                emailVerified: true,
              },
              membership: true,
            }),
          ],
        ]),
      }),
    };
    return context;
  };
  test.each([
    ["user_2", "org_1"],
    ["user_1", "org_2"],
  ])(
    "catalog and schema discovery hide without caller grant: %s %s",
    async (userId, organizationId) => {
      const context = fixtureContext(userId, organizationId);
      const list = await handleMcpToolCall({
        toolName: "list_capabilities",
        args: { limit: 50 },
        context,
      });
      const listedIds = parseToolPayload<{ items: { id: string }[] }>(
        list,
      ).items.map((item) => item.id);
      for (const { id, featureAccess } of capabilityCatalog) {
        if (featureAccess === "conditional") {
          continue;
        }
        expect(listedIds).not.toContain(id);
        const described = await handleMcpToolCall({
          toolName: "describe_capability",
          args: { capability: id },
          context,
        });
        expect(errorEnvelope(described).code, id).toBe("not_found");
        const invoked = await handleCapabilityCall({
          args: { capability: id, validate_only: true },
          context,
        });
        expect(errorEnvelope(invoked).code, id).toBe("not_found");
      }
      expect(loadOrgSettingsMock).not.toHaveBeenCalled();
      const typo = await handleMcpToolCall({
        toolName: "describe_capability",
        args: { capability: "time-entries.creat" },
        context,
      });
      expect(errorEnvelope(typo).hint).not.toContain("time-entries.create");
    },
  );
  test("caller grant permits real catalog and live schema discovery", async () => {
    const context = fixtureContext("user_1", "org_1");
    const list = await handleMcpToolCall({
      toolName: "list_capabilities",
      args: { limit: 50 },
      context,
    });
    expect(
      parseToolPayload<{ items: unknown[] }>(list).items.length,
    ).toBeGreaterThan(0);
    const described = await handleMcpToolCall({
      toolName: "describe_capability",
      args: { capability: "time-entries.create" },
      context,
    });
    expect(parseToolPayload<{ id: string }>(described).id).toBe(
      "time-entries.create",
    );
  });
});

test.each(["default-deny", "granted", "colleague"] as const)(
  "MCP conditional query admission for %s",
  async (kind) => {
    const featureId = "fixture-query-access";
    const organizationId = toSafeId<"organization">("org_1");
    const userId = toSafeId<"user">(kind === "colleague" ? "user_2" : "user_1");
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const checkedQueries: unknown[] = [];
    const select = mock(() => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
      }),
    }));
    const insert = mock(() => undefined);
    const database = createScopedDbMock({ select, insert });
    const context = createContext({
      workspaceIds: [workspaceId],
      safeDb: database.safeDb,
      scopedDb: database.scopedDb,
    });
    context.userId = userId;
    context.featureAccessSnapshot = createFeatureAccessSnapshot({
      organizationId,
      userId,
      decisions: new Map([
        [
          "time-billing",
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            grants: {},
            featureId: "time-billing",
            organizationId,
            userId,
            membership: true,
            user: { email: "standard@example.test", emailVerified: true },
            enrolments: [{ featureId: "time-billing", organizationId, userId }],
          }),
        ],
        [
          featureId,
          decideFeatureAccess({
            registry: { [featureId]: { enrolment: "invitation" } },
            featureId,
            organizationId,
            userId,
            user: {
              email:
                kind === "colleague"
                  ? "colleague@example.test"
                  : "member@example.test",
              emailVerified: true,
            },
            membership: true,
            grants:
              kind === "default-deny"
                ? {}
                : {
                    [featureId]: [
                      {
                        type: "member",
                        organizationId,
                        email: "member@example.test",
                      },
                    ],
                  },
          }),
        ],
      ]),
    });
    const previous = Object.getOwnPropertyDescriptor(
      exportTimeEntriesCsv.config,
      "featureAccess",
    );
    Object.defineProperty(exportTimeEntriesCsv.config, "featureAccess", {
      configurable: true,
      value: {
        type: "conditional",
        decision: "when-used",
        featureId,
        usesFeature: async ({ query }: { query: unknown }) => {
          checkedQueries.push(query);
          return isRecord(query) && query["dateFrom"] === "2026-10-02";
        },
        projectInputSchema: (schemas: AdvertisedSchemas) => schemas,
      },
    });
    try {
      for (const validate_only of [true, false]) {
        const result = await handleCapabilityCall({
          context,
          args: {
            capability: "time-entries.csv.export",
            validate_only,
            input: {
              params: { matterId: workspaceId },
              query: { dateFrom: "2026-10-02", status: "approved" },
            },
          },
        });
        if (kind === "granted") {
          expect(result.isError).not.toBe(true);
          if (validate_only) {
            expect(
              parseToolPayload<{ valid: boolean; capability: string }>(result),
            ).toEqual({
              valid: true,
              capability: "time-entries.csv.export",
            });
          }
        } else {
          expect(errorEnvelope(result)).toMatchObject({
            code: "not_found",
            message: "Not found",
          });
          expect(select).not.toHaveBeenCalled();
          expect(insert).not.toHaveBeenCalled();
          expect(loadOrgSettingsMock).not.toHaveBeenCalled();
          expect(consumeRateLimitMock).not.toHaveBeenCalled();
        }
      }
      expect(checkedQueries).toEqual(
        kind === "granted"
          ? []
          : [
              { dateFrom: "2026-10-02", status: "approved" },
              { dateFrom: "2026-10-02", status: "approved" },
            ],
      );
      const ordinary = await handleCapabilityCall({
        context,
        args: {
          capability: "time-entries.csv.export",
          validate_only: false,
          input: {
            params: { matterId: workspaceId },
            query: { dateFrom: "2026-10-01", status: "approved" },
          },
        },
      });
      expect(ordinary.isError).not.toBe(true);
      expect(select).toHaveBeenCalledTimes(kind === "granted" ? 2 : 1);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(exportTimeEntriesCsv.config, "featureAccess");
      } else {
        Object.defineProperty(
          exportTimeEntriesCsv.config,
          "featureAccess",
          previous,
        );
      }
    }
  },
);

for (const grants of [
  [],
  [LEGAL_LISTS_FEATURE_ID],
  [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
]) {
  test(`real list catalogue discovery with ${grants.length} grants`, async () => {
    const context = createContext();
    const grantMap = Object.fromEntries(
      grants.map((id) => [
        id,
        [{ type: "organization" as const, organizationId: "org_1" }],
      ]),
    );
    context.featureAccessSnapshot = createFeatureAccessSnapshot({
      organizationId: "org_1",
      userId: "user_1",
      decisions: new Map(
        Object.keys(FEATURE_REGISTRY).map((featureId) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            grants: grantMap,
            featureId,
            organizationId: "org_1",
            userId: "user_1",
            membership: true,
            user: { email: "standard@example.test", emailVerified: true },
          }),
        ]),
      ),
    });
    const entries = capabilityCatalog.filter((entry) =>
      entry.id.startsWith("lists."),
    );
    expect(entries.length).toBeGreaterThan(0);
    const list = await handleMcpToolCall({
      toolName: "list_capabilities",
      args: { domain: "lists", limit: MAX_LIST_LIMIT },
      context,
    });
    const listed = parseToolPayload<{ items: { id: string }[] }>(
      list,
    ).items.map((item) => item.id);
    for (const entry of entries) {
      expect(entry.featureAccess).toBe("required");
      expect(entry.featureId).toBeDefined();
      const enabled =
        entry.featureId === LEGAL_LISTS_FEATURE_ID
          ? grants.length > 0
          : grants.length === 2;
      expect(listed.includes(entry.id)).toBe(enabled);
      const schema = await handleMcpToolCall({
        toolName: "describe_capability",
        args: { capability: entry.id },
        context,
      });
      if (enabled) {
        expect(parseToolPayload<{ id: string }>(schema).id).toBe(entry.id);
        continue;
      }
      // A hidden capability answers exactly like an unknown id, and its hint
      // never names another hidden capability.
      const hidden = entries
        .filter((candidate) => !listed.includes(candidate.id))
        .map((candidate) => candidate.id);
      const expectUnknownId = (result: ToolCallResult) => {
        const envelope = errorEnvelope(result);
        expect(envelope).toMatchObject({
          code: "not_found",
          message: `No capability with id "${entry.id}"`,
        });
        for (const id of hidden) {
          expect(JSON.stringify(envelope)).not.toContain(`\`${id}\``);
        }
      };
      expectUnknownId(schema);
      for (const toolName of Object.values(MCP_CAPABILITY_EXECUTORS)) {
        for (const validate_only of [false, true]) {
          expectUnknownId(
            await handleMcpToolCall({
              toolName,
              args: { capability: entry.id, validate_only },
              context,
            }),
          );
        }
      }
    }
  });
}

describe("capability executor access isolation", () => {
  const enabledContext = () => {
    const context = createContext({ grantedScopes: [...MCP_OAUTH_SCOPES] });
    const grants = Object.fromEntries(
      Object.keys(FEATURE_REGISTRY).map((featureId) => [
        featureId,
        [
          {
            type: "organization" as const,
            organizationId: context.organizationId,
          },
        ],
      ]),
    );
    const enrolments = Object.keys(FEATURE_REGISTRY).map((featureId) => ({
      featureId,
      organizationId: context.organizationId,
      userId: context.userId,
    }));
    const enabled = {
      ...context,
      featureAccessSnapshot: createFeatureAccessSnapshot({
        organizationId: context.organizationId,
        userId: context.userId,
        decisions: new Map(
          Object.keys(FEATURE_REGISTRY).map((featureId) => [
            featureId,
            decideFeatureAccess({
              registry: FEATURE_REGISTRY,
              grants,
              featureId,
              organizationId: context.organizationId,
              userId: context.userId,
              user: { email: "standard@example.test", emailVerified: true },
              membership: true,
              enrolments,
            }),
          ]),
        ),
      }),
    };
    for (const featureId of Object.keys(FEATURE_REGISTRY)) {
      expect(
        isFeatureEnabled(enabled.featureAccessSnapshot, featureId, enabled),
        featureId,
      ).toBe(true);
    }
    return enabled;
  };

  test("every catalog capability is refused by the opposite executor before dispatch", async () => {
    const context = enabledContext();
    const classes = new Set<string>();
    for (const entry of capabilityCatalog) {
      classes.add(entry.access);
      const toolName =
        entry.access === "read"
          ? MCP_CAPABILITY_EXECUTORS.write
          : MCP_CAPABILITY_EXECUTORS.read;
      const result = await handleMcpToolCall({
        args: { capability: entry.id, validate_only: true, input: {} },
        context,
        toolName,
      });
      const error = errorEnvelope(result);
      expect(error.code, entry.id).toBe("validation_error");
      expect(error.hint, entry.id).toContain(
        MCP_CAPABILITY_EXECUTORS[entry.access],
      );
    }
    expect([...classes].toSorted()).toEqual(["read", "write"]);
    expect(consumeRateLimitMock).not.toHaveBeenCalled();
    expect(analytics.exceptions()).toEqual([]);
  });

  test("the retired mixed executor is absent from every exposed audience", async () => {
    for (const mode of ["default", "documents", "anonymized", "law"] as const) {
      const definitions = listStaticMcpToolDefinitions(mode);
      expect(definitions.some(({ name }) => name === "invoke_capability")).toBe(
        false,
      );
      for (const definition of definitions) {
        if (definition.access === "write") {
          expect(definition.readClass, definition.name).toBeUndefined();
        }
      }
    }
    const result = await call("invoke_capability", {
      capability: "matters.list",
    });
    expect(errorEnvelope(result).code).toBe("unknown_tool");
  });

  test("read executor rejects write-only confirmation arguments", async () => {
    const result = await call(MCP_CAPABILITY_EXECUTORS.read, {
      capability: "matters.list",
      confirm: true,
    });
    expect(errorEnvelope(result).code).toBe("validation_error");
  });
});

describe("personal search history capabilities", () => {
  test("keeps personal history discovery and invocation out of AI chat", () => {
    for (const tool of [
      "list_capabilities",
      "describe_capability",
      MCP_CAPABILITY_EXECUTORS.read,
    ] as const) {
      expect(READ_TOOL_REF_FIELD_MAP[tool].chatProjectable).toBe(false);
    }
    expect(
      WRITE_TOOL_REF_FIELD_MAP[MCP_CAPABILITY_EXECUTORS.write].chatProjectable,
    ).toBe(false);
  });
  test("describes caller-owned history and required mutation scope preconditions", async () => {
    for (const capability of [
      "search-history.list",
      "search-history.delete",
      "search-history.clear",
    ]) {
      const result = await call("describe_capability", { capability });
      const payload = parseToolPayload<{
        id: string;
        handlerKind: string;
        inputSchema: unknown;
      }>(result);
      expect(payload.id).toBe(capability);
      expect(payload.handlerKind).toBe("root");
      if (capability === "search-history.list") {
        expect(payload.inputSchema).toHaveProperty("query.properties.kind");
        expect(payload.inputSchema).not.toHaveProperty(
          "query.properties.kind.default",
        );
      }
      for (const part of ["query", "params", "body"]) {
        expect(payload.inputSchema).not.toHaveProperty(
          `${part}.properties.organizationId`,
        );
        expect(payload.inputSchema).not.toHaveProperty(
          `${part}.properties.userId`,
        );
      }
      if (capability !== "search-history.list") {
        expect(payload.inputSchema).toHaveProperty(
          "query.properties.expectedOrganizationId",
        );
        expect(payload.inputSchema).toHaveProperty(
          "query.properties.expectedUserId",
        );
        expect(payload.inputSchema).toHaveProperty("query.required", [
          "expectedOrganizationId",
          "expectedUserId",
        ]);
      }
    }
  });

  test("lists own history without a kind filter when kind is omitted", async () => {
    const queries: string[] = [];
    const database = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            queries.push(new PgDialect().sqlToQuery(condition).sql);
            return { orderBy: () => ({ limit: async () => [] }) };
          },
        }),
      }),
    });
    const result = await handleCapabilityCall({
      args: {
        capability: "search-history.list",
        input: { query: { limit: 20 } },
      },
      context: createContext(database),
    });
    expect(parseToolPayload(result)).toMatchObject({
      items: [],
      nextCursor: null,
      scope: { organizationId: "org_1", userId: "user_1" },
    });
    expect(queries).toHaveLength(1);
    expect(queries.at(0)).not.toContain('"kind"');
    expect(queries.at(0)).toContain('"organization_id"');
    expect(queries.at(0)).toContain('"user_id"');
  });

  test("deletes and clears own history through the shared handlers", async () => {
    const entryId = "a1111111-1111-4111-8111-111111111111";
    for (const capability of [
      "search-history.delete",
      "search-history.clear",
    ]) {
      const recordedEvents: (typeof auditLogs.$inferInsert)[] = [];
      const database = createScopedDbMock({
        insert: (table: unknown) => {
          expect(table).toBe(auditLogs);
          return {
            values: async (
              rows: readonly (typeof auditLogs.$inferInsert)[],
            ) => {
              recordedEvents.push(...rows);
            },
          };
        },
        delete: () => ({
          where: () => ({
            returning: async () => [{ id: entryId, kind: "search" }],
          }),
        }),
        $with: () => ({ as: () => ({ kind: "search" }) }),
        with: () => ({
          select: () => ({
            from: () => ({
              groupBy: async () => [{ kind: "search", deleted: 1 }],
            }),
          }),
        }),
      });
      const context = createContext(database);
      const result = await handleCapabilityCall({
        args: {
          capability,
          input: {
            ...(capability === "search-history.delete"
              ? { params: { entryId } }
              : {}),
            query: {
              expectedOrganizationId: context.organizationId,
              expectedUserId: context.userId,
            },
          },
          confirm: true,
        },
        context,
      });
      const payload = parseToolPayload(result);
      if (capability === "search-history.delete") {
        expect(payload).toEqual({ id: entryId });
      } else {
        expect(payload).toEqual({ deleted: 1 });
      }
      expect(recordedEvents).toMatchObject([
        {
          userId: context.userId,
          organizationId: context.organizationId,
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.SEARCH_HISTORY,
          resourceId:
            capability === "search-history.delete" ? entryId : context.userId,
          metadata: {
            operation:
              capability === "search-history.delete" ? "delete" : "clear",
            entryCount: 1,
            kinds: [],
          },
        },
      ]);
    }
  });

  test.each([
    {
      changed: "organization",
      query: { expectedOrganizationId: "other_org", expectedUserId: "user_1" },
    },
    {
      changed: "user",
      query: { expectedOrganizationId: "org_1", expectedUserId: "other_user" },
    },
  ])(
    "mutation scope preconditions reject changed $changed before accessing history",
    async ({ query }) => {
      for (const capability of [
        "search-history.clear",
        "search-history.delete",
      ]) {
        const database = createScopedDbMock({});
        const result = await handleCapabilityCall({
          args: {
            capability,
            input: {
              ...(capability === "search-history.delete"
                ? {
                    params: { entryId: "a3333333-3333-4333-8333-333333333333" },
                  }
                : {}),
              query,
            },
            confirm: true,
          },
          context: createContext(database),
        });
        expect(errorEnvelope(result).code).toBe("conflict");
        expect(database.getCallCount()).toBe(0);
      }
    },
  );

  test("mutations require both scope preconditions before accessing history", async () => {
    for (const capability of [
      "search-history.clear",
      "search-history.delete",
    ]) {
      const database = createScopedDbMock({});
      const result = await handleCapabilityCall({
        args: {
          capability,
          input: {
            ...(capability === "search-history.delete"
              ? { params: { entryId: "a3333333-3333-4333-8333-333333333333" } }
              : {}),
            query: {},
          },
          confirm: true,
        },
        context: createContext(database),
      });
      expect(errorEnvelope(result).code).toBe("validation_error");
      expect(database.getCallCount()).toBe(0);
    }
  });

  test("deleting history requires write consent and explicit confirmation", async () => {
    for (const capability of [
      "search-history.delete",
      "search-history.clear",
    ]) {
      const readOnlyResult = await handleCapabilityCall({
        args: { capability, input: {}, confirm: true },
        context: createContext({ grantedScopes: ["stella:read"] }),
      });
      expect(errorEnvelope(readOnlyResult).code).toBe("missing_scope");
      expect(errorEnvelope(await callCapability({ capability })).code).toBe(
        "confirmation_required",
      );
    }
  });

  test("delete validates ids before invoking the database", async () => {
    const result = await callCapability({
      capability: "search-history.delete",
      input: {
        params: { entryId: "invalid-history-id" },
        query: { expectedOrganizationId: "org_1", expectedUserId: "user_1" },
      },
      confirm: true,
    });
    expect(errorEnvelope(result).code).toBe("validation_error");
  });
});
