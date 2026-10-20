import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { Transaction } from "@/api/db/root";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { recordSkillReadAudit } from "@/api/lib/agent-skills/skill-read-audit";
import type { LoadedChatSkill } from "@/api/lib/agent-skills/skills";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { MCP_MODES, MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  MCP_DISPATCH_ADMISSION,
  MCP_DISPATCH_FAMILIES,
  type McpDispatchFamily,
} from "@/api/mcp/dispatch-admission";
import {
  dispatchGatewayToolCall,
  type GatewayDispatchDependencies,
} from "@/api/mcp/gateway/dispatch-call";
import {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
  type ExternalGatewayDependencies,
} from "@/api/mcp/gateway/external-tools";
import {
  externalToolDefinition,
  skillToolDefinition,
} from "@/api/mcp/gateway/list-tools";
import {
  resolveSkillTool,
  SKILL_TOOL_READ_TYPE,
} from "@/api/mcp/gateway/skills";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import {
  PUBLIC_MCP_TOOL_DEFINITION,
  type McpToolDefinition,
} from "@/api/mcp/tool-types";
import {
  handleMcpToolCall,
  invokePublicMcpHandler,
  listMcpTools,
} from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const PROBE_ARGUMENT = "authority_census_probe";
const SKILL_NAME = "skill__authority_fixture";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const connectorTool = {
  exposedName: "mcp__fixture__read",
  inputSchema: { type: "object", properties: {} },
  rawName: "read",
  readOnlyHint: true,
} satisfies CachedMcpToolDefinition;
const connector = {
  responseDisposition: "normal",
  allowedTools: null,
  connectorId: toSafeId<"mcpConnector">("connector_fixture"),
  description: "Fixture connector",
  displayName: "Fixture",
  slug: "fixture",
  type: "none",
  url: "https://mcp.example.test",
  userConnectionId: toSafeId<"mcpUserConnection">("connection_fixture"),
} satisfies LoadedMcpConnection;
const connectorDependencies = {
  loadActiveMcpConnectionsForUser: async () => [connector],
  proxyMcpToolCall: async () => ({ content: [] }),
  refreshCachedMcpToolsForConnection: async () => undefined,
} satisfies ExternalGatewayDependencies;
const connectorRows = [
  {
    allowedTools: null,
    cachedTools: [connectorTool],
    connectorId: connector.connectorId,
    displayName: connector.displayName,
    slug: connector.slug,
    userConnectionId: connector.userConnectionId,
  },
];
const skillRows = [
  {
    id: toSafeId<"agentSkill">("00000000-0000-4000-8000-000000000002"),
    scope: "private" as const,
    userId: "user_fixture",
    slug: "authority_fixture",
    name: "Authority fixture",
    description: "Fixture skill",
    version: "1.0.0",
    license: null,
    compatibility: null,
    metadata: {},
    body: "Read the fixture.",
    invocation: "auto" as const,
    origin: "authored" as const,
  },
];
const loadedSkill = {
  body: "Read the fixture.",
  compatibility: null,
  description: "Fixture skill",
  id: toSafeId<"agentSkill">("00000000-0000-4000-8000-000000000002"),
  license: null,
  metadata: {},
  name: "authority_fixture",
  origin: "authored" as const,
  resources: [],
  source: "installed" as const,
  version: "1.0.0",
} satisfies LoadedChatSkill;

const transactionWithRows = (
  rowsForSelection: (selection: Record<string, unknown>) => readonly unknown[],
) =>
  asTestRaw<Transaction>({
    select: (selection: Record<string, unknown>) => {
      const rows = rowsForSelection(selection);
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        leftJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        offset: () => builder,
        limit: async () => rows,
      };
      return builder;
    },
  });

const fixtureTransaction = transactionWithRows((selection) =>
  "cachedTools" in selection ? connectorRows : skillRows,
);
const emptyTransaction = transactionWithRows(() => []);

const safeDb: McpRequestContext["safeDb"] = async (callback) =>
  Result.ok(await callback(fixtureTransaction));

type DataDependencyCalls = { safeDb: number; scopedDb: number };

const trackingSafeDb =
  (calls: DataDependencyCalls): McpRequestContext["safeDb"] =>
  async (callback) => {
    calls.safeDb += 1;
    return Result.ok(await callback(emptyTransaction));
  };

const trackingScopedDb =
  (calls?: DataDependencyCalls): McpRequestContext["scopedDb"] =>
  async (callback) => {
    if (calls !== undefined) {
      calls.scopedDb += 1;
    }
    return await callback(emptyTransaction);
  };

const contextFor = (
  credentialPermissions: McpRequestContext["credentialPermissions"],
  dataDependencyCalls?: DataDependencyCalls,
): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([toSafeId<"workspace">(WORKSPACE_ID)]),
    accessibleWorkspaceStatusById: new Map([
      [toSafeId<"workspace">(WORKSPACE_ID), "active"],
    ]),
    accessibleWorkspaces: [],
    credentialPermissions,
    featureAccessSnapshot: createFeatureAccessSnapshot({
      userId: "user_fixture",
      organizationId: "org_fixture",
      decisions: new Map(
        Object.entries(FEATURE_REGISTRY).map(([featureId, definition]) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId,
            userId: "user_fixture",
            organizationId: "org_fixture",
            membership: true,
            user: { email: "member@example.test", emailVerified: true },
            grants: Object.fromEntries(
              Object.keys(FEATURE_REGISTRY).map((id) => [
                id,
                [
                  {
                    type: "organization" as const,
                    organizationId: "org_fixture",
                  },
                ],
              ]),
            ),
            enrolments:
              definition.enrolment === "self-serve"
                ? [
                    {
                      featureId,
                      userId: "user_fixture",
                      organizationId: "org_fixture",
                    },
                  ]
                : [],
          }),
        ]),
      ),
    }),
    grantedScopes: MCP_OAUTH_SCOPES,
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_fixture"),
    recordAuditEvent: async () => undefined,
    safeDb:
      dataDependencyCalls === undefined
        ? safeDb
        : trackingSafeDb(dataDependencyCalls),
    scopedDb: trackingScopedDb(dataDependencyCalls),
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    userEmail: "member@example.test",
    userId: toSafeId<"user">("user_fixture"),
  });

const fixtureSkill = skillToolDefinition({
  description: "Fixture skill",
  displayName: "Authority fixture",
  exposedName: SKILL_NAME,
});
const fixtureConnector = externalToolDefinition({
  cachedTool: connectorTool,
  connectorDisplayName: connector.displayName,
});

type CensusEntry = {
  mode: McpMode;
  definition: McpToolDefinition;
};

const census = (): CensusEntry[] => [
  ...MCP_MODES.flatMap((mode) =>
    listStaticMcpToolDefinitions(mode).map((definition) => ({
      mode,
      definition,
    })),
  ),
  { mode: "advanced", definition: fixtureConnector },
  { mode: "advanced", definition: fixtureSkill },
];

const gatewayDependencies = {
  callGatewayExternalMcpTool: async (args) =>
    await callGatewayExternalMcpTool({
      ...args,
      dependencies: connectorDependencies,
    }),
  gatewayLoadErrorResult,
  readSkillTool: async () => null,
  recordSkillReadAudit,
  resolveSkillTool: async (args) =>
    await resolveSkillTool({
      ...args,
      context: contextFor({ chat: ["create"] }),
    }),
} satisfies GatewayDispatchDependencies;

const dispatchDependencies = {
  dispatchGatewayToolCall: async (args) =>
    await dispatchGatewayToolCall({
      ...args,
      dependencies: gatewayDependencies,
    }),
} satisfies { dispatchGatewayToolCall: typeof dispatchGatewayToolCall };

const listedNames = async (entry: CensusEntry, context: McpRequestContext) =>
  new Set(
    (
      await listMcpTools(
        context,
        entry.mode,
        context.grantedScopes,
        connectorDependencies,
      )
    ).map(({ name }) => name),
  );

const errorCodeOf = (result: CallToolResult): string | null => {
  const item = result.content.at(0);
  if (item?.type !== "text" || !item.text.startsWith("{")) {
    return null;
  }
  const payload: unknown = JSON.parse(item.text);
  const parsed = v.safeParse(
    v.object({ error: v.object({ code: v.string() }) }),
    payload,
  );
  return parsed.success ? parsed.output.error.code : null;
};

const call = async (entry: CensusEntry, context: McpRequestContext) =>
  await handleMcpToolCall({
    args:
      entry.definition.name === SKILL_NAME ? {} : { [PROBE_ARGUMENT]: true },
    context,
    dependencies: dispatchDependencies,
    mode: entry.mode,
    toolName: entry.definition.name,
  });

const expectedCounts = {
  advanced: 78,
  default: 72,
  documents: 13,
  anonymized: 34,
  law: 15,
} as const satisfies Record<McpMode, number>;

const tenantResourceAuthorities = {
  get_usage: {
    workspace: ["read"],
    organizationSettings: ["update"],
  },
  list_audit_log: { workspace: ["read"], auditLog: ["read"] },
  list_time_entries: { workspace: ["read"], timeEntry: ["read"] },
  resolve_rate: { workspace: ["read"], rate: ["read"] },
} as const;

const validTenantCalls = [
  {
    name: "list_time_entries",
    args: { matter_id: WORKSPACE_ID },
    dependency: "scopedDb",
  },
  {
    name: "resolve_rate",
    args: {
      matter_id: WORKSPACE_ID,
      user_id: "user_fixture",
      date: "2026-10-19",
    },
    dependency: "safeDb",
  },
  {
    name: "list_invoices",
    args: { matter_id: WORKSPACE_ID },
    dependency: "scopedDb",
  },
  { name: "get_usage", args: {}, dependency: "safeDb" },
  { name: "list_audit_log", args: {}, dependency: "safeDb" },
] as const satisfies readonly {
  name: string;
  args: Record<string, unknown>;
  dependency: keyof DataDependencyCalls;
}[];

const chatTenantCallNames = new Set([
  "list_time_entries",
  "list_invoices",
  "get_usage",
]);

describe("MCP tool authority census", () => {
  test("every dispatch family declares its admission owner", () => {
    expect(Object.keys(MCP_DISPATCH_ADMISSION).toSorted()).toEqual(
      [...MCP_DISPATCH_FAMILIES].toSorted(),
    );
  });

  test("covers every mode and dynamic family", () => {
    const entries = census();
    for (const mode of MCP_MODES) {
      expect(entries.filter((entry) => entry.mode === mode)).toHaveLength(
        expectedCounts[mode],
      );
    }
    expect(
      entries.some(({ definition }) => definition.name === SKILL_NAME),
    ).toBeTrue();
    expect(
      entries.some(
        ({ definition }) => definition.name === connectorTool.exposedName,
      ),
    ).toBeTrue();
  });

  test("every registered tool declares its authority", () => {
    for (const { definition } of census()) {
      if (definition.access === "read") {
        expect(definition.authority.kind).toBeOneOf(["public", "tenant"]);
      } else {
        expect(definition.permissions.type).toBeDefined();
      }
    }
  });

  test("every public static definition uses the public constructor", () => {
    for (const mode of MCP_MODES) {
      for (const definition of listStaticMcpToolDefinitions(mode)) {
        if (
          definition.access === "read" &&
          definition.authority.kind === "public"
        ) {
          expect(
            PUBLIC_MCP_TOOL_DEFINITION in definition,
            `${mode}:${definition.name}`,
          ).toBeTrue();
        }
      }
    }
  });

  test("tenant resource reads declare their complete authority", () => {
    for (const [name, permissions] of Object.entries(
      tenantResourceAuthorities,
    )) {
      const definitions = census()
        .map(({ definition }) => definition)
        .filter((definition) => definition.name === name);
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions) {
        expect(definition.access).toBe("read");
        if (definition.access !== "read") {
          continue;
        }
        expect(JSON.stringify(definition.authority)).toBe(
          JSON.stringify({ kind: "tenant", permissions }),
        );
      }
    }
  });

  test("declared tenant permissions reach handlers with valid input", async () => {
    const definitions = listStaticMcpToolDefinitions("advanced");

    for (const validCall of validTenantCalls) {
      const definition = definitions.find(
        ({ name }) => name === validCall.name,
      );
      expect(definition?.access).toBe("read");
      if (
        definition?.access !== "read" ||
        definition.authority.kind !== "tenant"
      ) {
        continue;
      }

      const calls: DataDependencyCalls = { safeDb: 0, scopedDb: 0 };
      const result = await handleMcpToolCall({
        args: validCall.args,
        context: contextFor(definition.authority.permissions, calls),
        dependencies: dispatchDependencies,
        mode: "advanced",
        toolName: definition.name,
      });

      expect(calls[validCall.dependency], validCall.name).toBeGreaterThan(0);
      expect(errorCodeOf(result), validCall.name).not.toBe("permission_denied");
    }
  });

  test("dispatch builds the public handler context", async () => {
    const context = contextFor({ workspace: ["read"] });
    context.testDependencies = {
      resolveDecision: async ({ admission }) => {
        expect(admission).toBeDefined();
        return { status: "country_unavailable" };
      },
    };

    const result = await handleMcpToolCall({
      args: { country: "CZE", identifier: "1 Cdo 1/2026" },
      context,
      dependencies: dispatchDependencies,
      mode: "advanced",
      toolName: "resolve_case_law_decision",
    });

    expect(errorCodeOf(result)).toBeNull();

    await invokePublicMcpHandler(
      ({ context: handlerContext }) => {
        expect("organizationId" in handlerContext).toBeFalse();
        expect("scopedDb" in handlerContext).toBeFalse();
        return { status: "success", data: {} };
      },
      {},
      context,
    );
  });

  test("chat reads apply each tenant declaration before their handler", async () => {
    const definitions = listStaticMcpToolDefinitions("advanced");

    for (const validCall of validTenantCalls.filter(({ name }) =>
      chatTenantCallNames.has(name),
    )) {
      const definition = definitions.find(
        ({ name }) => name === validCall.name,
      );
      expect(definition?.access).toBe("read");
      if (
        definition?.access !== "read" ||
        definition.authority.kind !== "tenant"
      ) {
        continue;
      }

      const refRegistry = createChatRefRegistry();
      const matterRef = refRegistry.toMatterRef(
        toSafeId<"workspace">(WORKSPACE_ID),
      );
      const args =
        "matter_id" in validCall.args
          ? { ...validCall.args, matter_id: matterRef }
          : validCall.args;
      const refusedCalls: DataDependencyCalls = { safeDb: 0, scopedDb: 0 };
      const refused = await runRegistryReadTool({
        args,
        context: contextFor({ workspace: [] }, refusedCalls),
        refRegistry,
        toolName: validCall.name,
      });

      expect(Result.isError(refused), validCall.name).toBeTrue();
      if (Result.isError(refused)) {
        expect(refused.error.kind, validCall.name).toBe("unavailable");
      }
      expect(refusedCalls, validCall.name).toEqual({ safeDb: 0, scopedDb: 0 });

      const allowedCalls: DataDependencyCalls = { safeDb: 0, scopedDb: 0 };
      const allowed = await runRegistryReadTool({
        args,
        context: contextFor(definition.authority.permissions, allowedCalls),
        refRegistry,
        toolName: validCall.name,
      });
      if (Result.isError(allowed)) {
        expect(allowed.error.kind, validCall.name).not.toBe("unavailable");
      }
    }
  });

  test("read authority controls listing and dispatch in every mode", async () => {
    const narrowed = contextFor({ timeEntry: ["read"] });
    const reads = census().filter(
      ({ definition }) => definition.access === "read",
    );
    expect(reads.length).toBeGreaterThan(0);

    for (const entry of reads) {
      const { definition } = entry;
      if (definition.access !== "read") {
        continue;
      }
      const narrowedListed = await listedNames(entry, narrowed);
      const narrowedCode = errorCodeOf(await call(entry, narrowed));

      if (definition.authority.kind === "public") {
        expect(narrowedListed.has(definition.name)).toBeTrue();
        expect(narrowedCode).not.toBe("permission_denied");
        continue;
      }

      expect(narrowedListed.has(definition.name)).toBeFalse();
      expect({
        mode: entry.mode,
        name: definition.name,
        code: narrowedCode,
      }).toEqual({
        mode: entry.mode,
        name: definition.name,
        code: "permission_denied",
      });

      const declared = contextFor(definition.authority.permissions);
      expect({
        mode: entry.mode,
        name: definition.name,
        listed: (await listedNames(entry, declared)).has(definition.name),
      }).toEqual({ mode: entry.mode, name: definition.name, listed: true });
      expect(errorCodeOf(await call(entry, declared))).not.toBe(
        "permission_denied",
      );
    }
  });

  test("every dispatch family admits authorised calls after authority", async () => {
    const exercised: Record<McpDispatchFamily, number> = {
      static: 0,
      capability: 0,
      external_mcp: 0,
      skill: 0,
    };
    const admittedContext = contextFor({
      chat: ["create"],
      timeEntry: ["read"],
      workspace: ["read"],
    });
    admittedContext.admitToolInvocation = async (invoke) => {
      exercised.static += 1;
      return await invoke();
    };
    await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID },
      context: admittedContext,
      mode: "advanced",
      toolName: "list_time_entries",
    });

    admittedContext.admitToolInvocation = async (invoke) => {
      exercised.capability += 1;
      return await invoke();
    };
    const capabilityResult = await handleMcpToolCall({
      args: {
        capability: "time-entries.me.list",
        input: { query: { date: "2026-10-19" } },
        validate_only: true,
      },
      context: admittedContext,
      mode: "advanced",
      toolName: MCP_CAPABILITY_EXECUTORS.read,
    });
    expect(errorCodeOf(capabilityResult)).not.toBe("validation_error");

    admittedContext.admitToolInvocation = async (invoke) => {
      exercised.external_mcp += 1;
      return await invoke();
    };
    await call(
      { mode: "advanced", definition: fixtureConnector },
      admittedContext,
    );

    admittedContext.admitToolInvocation = async (invoke) => {
      exercised.skill += 1;
      return await invoke();
    };
    const skillDependencies = {
      ...gatewayDependencies,
      readSkillTool: async () => ({
        type: SKILL_TOOL_READ_TYPE.skill,
        skill: loadedSkill,
      }),
    } satisfies GatewayDispatchDependencies;
    await handleMcpToolCall({
      args: {},
      context: admittedContext,
      dependencies: {
        dispatchGatewayToolCall: async (args) =>
          await dispatchGatewayToolCall({
            ...args,
            dependencies: skillDependencies,
          }),
      },
      mode: "advanced",
      toolName: SKILL_NAME,
    });

    expect(exercised).toEqual({
      capability: 1,
      external_mcp: 1,
      skill: 1,
      static: 1,
    });

    const refusedContext = contextFor({ chat: [] });
    refusedContext.admitToolInvocation = async (invoke) => {
      exercised.static += 1;
      return await invoke();
    };
    await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID },
      context: refusedContext,
      mode: "advanced",
      toolName: "list_time_entries",
    });
    refusedContext.admitToolInvocation = async (invoke) => {
      exercised.capability += 1;
      return await invoke();
    };
    await handleMcpToolCall({
      args: {
        capability: "time-entries.me.list",
        input: { query: { date: "2026-10-19" } },
        validate_only: true,
      },
      context: refusedContext,
      mode: "advanced",
      toolName: MCP_CAPABILITY_EXECUTORS.read,
    });
    refusedContext.admitToolInvocation = async (invoke) => {
      exercised.external_mcp += 1;
      return await invoke();
    };
    await call(
      { mode: "advanced", definition: fixtureConnector },
      refusedContext,
    );
    refusedContext.admitToolInvocation = async (invoke) => {
      exercised.skill += 1;
      return await invoke();
    };
    await call({ mode: "advanced", definition: fixtureSkill }, refusedContext);

    expect(exercised).toEqual({
      capability: 1,
      external_mcp: 1,
      skill: 1,
      static: 1,
    });
  });
});
