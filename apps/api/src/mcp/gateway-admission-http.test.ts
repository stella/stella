import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { recordSkillReadAudit } from "@/api/lib/agent-skills/skill-read-audit";
import type { LoadedChatSkill } from "@/api/lib/agent-skills/skills";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  dispatchGatewayToolCall,
  type GatewayDispatchDependencies,
} from "@/api/mcp/gateway/dispatch-call";
import {
  callGatewayExternalMcpTool,
  gatewayLoadErrorResult,
} from "@/api/mcp/gateway/external-tools";
import {
  externalToolDefinition,
  skillToolDefinition,
} from "@/api/mcp/gateway/list-tools";
import { SKILL_TOOL_READ_TYPE } from "@/api/mcp/gateway/skills";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { callMcpToolOverHttp } from "@/api/tests/helpers/mcp-http-tool-call";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const CONNECTOR_NAME = "mcp__admission_fixture__read";
const SKILL_NAME = "skill__admission_fixture";
const connectorTool = {
  exposedName: CONNECTOR_NAME,
  inputSchema: { type: "object", properties: {} },
  rawName: "read",
  readOnlyHint: true,
} satisfies CachedMcpToolDefinition;
const connector = {
  responseDisposition: "normal",
  allowedTools: null,
  connectorId: toSafeId<"mcpConnector">("connector_admission_fixture"),
  description: "Fixture connector",
  displayName: "Fixture",
  slug: "admission-fixture",
  type: "none" as const,
  url: "https://mcp.example.test",
  userConnectionId: toSafeId<"mcpUserConnection">("connection_fixture"),
} satisfies LoadedMcpConnection;
const connectorDefinition = externalToolDefinition({
  cachedTool: connectorTool,
  connectorDisplayName: connector.displayName,
});
const resolvedSkill = {
  availability: { status: "available" as const },
  compatibility: null,
  description: "Fixture skill",
  displayName: "Admission fixture",
  exposedName: SKILL_NAME,
  id: toSafeId<"agentSkill">("00000000-0000-4000-8000-000000000002"),
  invocation: "auto" as const,
  license: null,
  metadata: {},
  name: "admission_fixture",
  origin: "authored" as const,
  scope: "private" as const,
  slug: "admission_fixture",
  source: "installed" as const,
  version: "1.0.0",
};
const skillDefinition = skillToolDefinition(resolvedSkill);
const loadedSkill = {
  body: "Read the fixture.",
  compatibility: resolvedSkill.compatibility,
  description: resolvedSkill.description,
  id: resolvedSkill.id,
  license: resolvedSkill.license,
  metadata: resolvedSkill.metadata,
  name: resolvedSkill.name,
  origin: resolvedSkill.origin,
  resources: [],
  source: resolvedSkill.source,
  version: resolvedSkill.version,
} satisfies LoadedChatSkill;

const transaction = asTestRaw<Transaction>({
  select: (selection: Record<string, unknown>) => {
    const rows =
      "cachedTools" in selection
        ? [
            {
              allowedTools: null,
              cachedTools: [connectorTool],
              connectorId: connector.connectorId,
              displayName: connector.displayName,
              slug: connector.slug,
              userConnectionId: connector.userConnectionId,
            },
          ]
        : [];
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

const safeDb: McpRequestContext["safeDb"] = async (callback) =>
  Result.ok(await callback(transaction));
const scopedDb: McpRequestContext["scopedDb"] = async (callback) =>
  await callback(transaction);

const createContext = (): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [],
    credentialPermissions: { chat: ["create"], workspace: ["read"] },
    grantedScopes: ["stella:external_mcps", "stella:skills"],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_fixture"),
    recordAuditEvent: async () => undefined,
    safeDb,
    scopedDb,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    userEmail: "member@example.test",
    userId: toSafeId<"user">("user_fixture"),
  });

const errorCodeOf = (
  result: Awaited<ReturnType<typeof callMcpToolOverHttp>>,
) => {
  const content = result.content.at(0);
  if (content?.type !== "text") {
    return null;
  }
  const parsed: unknown = JSON.parse(content.text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("error" in parsed) ||
    typeof parsed.error !== "object" ||
    parsed.error === null ||
    !("code" in parsed.error) ||
    typeof parsed.error.code !== "string"
  ) {
    return null;
  }
  return parsed.error.code;
};

const runFamily = async ({
  family,
  refuse,
}: {
  family: "connector" | "skill";
  refuse: boolean;
}) => {
  let admissions = 0;
  let executions = 0;
  const connectorDependencies = {
    loadActiveMcpConnectionsForUser: async () => [connector],
    proxyMcpToolCall: async () => {
      executions += 1;
      return { content: [] };
    },
    refreshCachedMcpToolsForConnection: async () => undefined,
  };
  const gatewayDependencies = {
    callGatewayExternalMcpTool: async (args) =>
      await callGatewayExternalMcpTool({
        ...args,
        dependencies: connectorDependencies,
      }),
    gatewayLoadErrorResult,
    readSkillTool: async () => {
      executions += 1;
      return {
        type: SKILL_TOOL_READ_TYPE.skill,
        skill: loadedSkill,
      };
    },
    recordSkillReadAudit,
    resolveSkillTool: async () => resolvedSkill,
  } satisfies GatewayDispatchDependencies;
  const definition =
    family === "connector" ? connectorDefinition : skillDefinition;
  const result = await callMcpToolOverHttp({
    admitAction: async ({ run }) => {
      admissions += 1;
      return refuse
        ? Result.err(
            new ActionAdmissionError({
              message: "Fixture admission refused",
              reason: "busy",
            }),
          )
        : Result.ok(
            await run(new AbortController().signal, {
              reservePeriod: async () => Result.ok(undefined),
            }),
          );
    },
    args: {},
    context: createContext(),
    getToolDefinition: async (toolName) =>
      toolName === definition.name ? definition : undefined,
    mode: "advanced",
    toolCallHandler: async (options) =>
      await handleMcpToolCall({
        ...options,
        dependencies: {
          dispatchGatewayToolCall: async (args) =>
            await dispatchGatewayToolCall({
              ...args,
              dependencies: gatewayDependencies,
            }),
        },
      }),
    toolName: definition.name,
  });
  return { admissions, executions, result };
};

describe("gateway admission over HTTP", () => {
  test.each(["connector", "skill"] as const)(
    "an authorised %s call admits once",
    async (family) => {
      const observed = await runFamily({ family, refuse: false });
      expect(observed.admissions).toBe(1);
      expect(observed.executions).toBe(1);
    },
  );

  test.each(["connector", "skill"] as const)(
    "an admission refusal stops the %s call",
    async (family) => {
      const observed = await runFamily({ family, refuse: true });
      expect(observed.admissions).toBe(1);
      expect(observed.executions).toBe(0);
      expect(errorCodeOf(observed.result)).toBe("action_concurrency_busy");
    },
  );
});
