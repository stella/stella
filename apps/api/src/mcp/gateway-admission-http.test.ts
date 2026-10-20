import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import https from "node:https";
import { PassThrough } from "node:stream";

import {
  buildDocumentVersionUploadReservationInput,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

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

void mock.module("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

void mock.module("node:https", () => ({
  ...https,
  request: (
    _options: unknown,
    onResponse: (
      response: PassThrough & {
        headers: Record<string, string>;
        statusCode: number;
      },
    ) => void,
  ) => {
    const request = Object.assign(new PassThrough(), {
      end: () => {
        const response = Object.assign(new PassThrough(), {
          headers: { "content-type": "application/octet-stream" },
          statusCode: 200,
        });
        queueMicrotask(() => {
          onResponse(response);
          response.end(new Uint8Array([1]));
        });
        return request;
      },
    });
    return request;
  },
}));

const CONNECTOR_NAME = "mcp__admission_fixture__read";
const SKILL_NAME = "skill__admission_fixture";
const ENTITY_ID = "00000000-0000-4000-8000-000000000010";
const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);
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
  query: {
    entities: {
      findFirst: async () => ({
        kind: "document",
        name: "Agreement",
        workspaceId: WORKSPACE_ID,
      }),
    },
  },
  select: (selection: Record<string, unknown>) => {
    const rows: Record<string, unknown>[] = [];
    if ("cachedTools" in selection) {
      rows.push({
        allowedTools: null,
        cachedTools: [connectorTool],
        connectorId: connector.connectorId,
        displayName: connector.displayName,
        slug: connector.slug,
        userConnectionId: connector.userConnectionId,
      });
    } else if ("id" in selection) {
      rows.push({ id: ENTITY_ID });
    }
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
const createOperationDatabaseScope: NonNullable<
  McpRequestContext["createOperationDatabaseScope"]
> = () => ({
  pinServerValidatedWorkspaceId: (workspaceId) => workspaceId === WORKSPACE_ID,
  safeDb,
  scopedDb,
});

const createContext = (
  overrides: Partial<McpRequestContext> = {},
): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [WORKSPACE_ID],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [{ id: WORKSPACE_ID, status: "active" }],
    grantedScopes: [
      "stella:documents_write",
      "stella:external_mcps",
      "stella:matters_write",
      "stella:read",
      "stella:skills",
    ],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_fixture"),
    createOperationDatabaseScope,
    recordAuditEvent: async () => undefined,
    request: new Request("https://api.example.test/mcp"),
    safeDb,
    scopedDb,
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    userEmail: "member@example.test",
    userId: toSafeId<"user">("user_fixture"),
    ...overrides,
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

const runStaticTool = async ({
  args,
  context = createContext(),
  mode,
  toolName,
}: {
  args: Record<string, unknown>;
  context?: McpRequestContext;
  mode: "documents" | "advanced";
  toolName: string;
}) => {
  let admissions = 0;
  const result = await callMcpToolOverHttp({
    admitAction: async ({ run }) => {
      admissions += 1;
      return Result.ok(
        await run(new AbortController().signal, {
          reservePeriod: async () => Result.ok(undefined),
        }),
      );
    },
    args,
    context,
    mode,
    toolName,
  });
  return { admissions, result };
};

describe("gateway admission over HTTP", () => {
  test("a static upload and its nested capability work admit once", async () => {
    let capabilityExecutions = 0;
    const observed = await runStaticTool({
      args: {
        entity_id: ENTITY_ID,
        file: {
          download_url: "https://files.example/agreement.docx",
          file_id: "file_1",
          file_name: "agreement.docx",
          mime_type: "application/octet-stream",
        },
      },
      context: createContext({
        testDependencies: {
          safeOutboundFetchBytes: async () =>
            await Promise.resolve(
              Result.ok({
                body: new Uint8Array([1]).buffer,
                headers: new Headers(),
                ok: true,
                status: 200,
              }),
            ),
          consumeInvokeCapabilityRateLimit: async () => {
            capabilityExecutions += 1;
            return { ok: true, retryAfterSeconds: 60 };
          },
        },
      }),
      mode: "documents",
      toolName: DOCUMENT_VERSION_UPLOAD_TRANSPORT.toolName,
    });

    expect(capabilityExecutions).toBe(1);
    expect(observed.admissions).toBe(1);
  });

  test("a direct capability refusal happens before admission", async () => {
    const observed = await runStaticTool({
      args: {
        capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
        input: buildDocumentVersionUploadReservationInput({
          entityId: ENTITY_ID,
          file: {
            mimeType: "application/octet-stream",
            name: "agreement.docx",
            sha256Hex: "a".repeat(64),
            size: 1,
          },
          workspaceId: WORKSPACE_ID,
        }),
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: { workspace: ["read"] },
      }),
      mode: "advanced",
      toolName: MCP_CAPABILITY_EXECUTORS.write,
    });

    expect(errorCodeOf(observed.result)).toBe("permission_denied");
    expect(observed.admissions).toBe(0);
  });

  test("a permitted direct capability executor call admits once", async () => {
    const observed = await runStaticTool({
      args: {
        capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
        input: buildDocumentVersionUploadReservationInput({
          entityId: ENTITY_ID,
          file: {
            mimeType: "application/octet-stream",
            name: "agreement.docx",
            sha256Hex: "a".repeat(64),
            size: 1,
          },
          workspaceId: WORKSPACE_ID,
        }),
        validate_only: true,
      },
      context: createContext({
        credentialPermissions: {
          entity: ["update"],
          workspace: ["read"],
        },
      }),
      mode: "advanced",
      toolName: MCP_CAPABILITY_EXECUTORS.write,
    });

    expect(observed.admissions).toBe(1);
  });

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
