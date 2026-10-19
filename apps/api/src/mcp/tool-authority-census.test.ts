import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { recordSkillReadAudit } from "@/api/lib/agent-skills/skill-read-audit";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
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
import { resolveSkillTool } from "@/api/mcp/gateway/skills";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { handleMcpToolCall, listMcpTools } from "@/api/mcp/tools";
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
    id: toSafeId<"agentSkill">("skill_authority_fixture"),
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

describe("MCP tool authority census", () => {
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
});
