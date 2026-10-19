import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { MCP_MODES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  callGatewayExternalMcpTool,
  type ExternalGatewayDependencies,
} from "@/api/mcp/gateway/external-tools";
import {
  externalToolDefinition,
  listGatewayMcpToolDefinitions,
  skillToolDefinition,
} from "@/api/mcp/gateway/list-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import {
  hasMcpToolAuthority,
  mcpToolAuthorityRefusal,
} from "@/api/mcp/tool-authority";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
const connectorRows = {
  from: () => connectorRows,
  innerJoin: () => connectorRows,
  where: () => connectorRows,
  orderBy: () => connectorRows,
  limit: async () => [
    {
      allowedTools: null,
      cachedTools: [connectorTool],
      connectorId: connector.connectorId,
      displayName: connector.displayName,
      slug: connector.slug,
      userConnectionId: connector.userConnectionId,
    },
  ],
};
const safeDb: McpRequestContext["safeDb"] = async (callback) =>
  Result.ok(
    await callback(asTestRaw<Transaction>({ select: () => connectorRows })),
  );
const narrowedContext = asTestRaw<McpRequestContext>({
  credentialPermissions: { timeEntry: ["read"] },
  grantedScopes: ["stella:external_mcps"],
  memberRole: "owner",
  organizationId: toSafeId<"organization">("org_fixture"),
  safeDb,
  thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
  userEmail: "member@example.test",
  userId: toSafeId<"user">("user_fixture"),
});

const definitions = (): McpToolDefinition[] => {
  const tools = new Map<string, McpToolDefinition>();
  for (const mode of MCP_MODES) {
    for (const definition of listStaticMcpToolDefinitions(mode)) {
      tools.set(definition.name, definition);
    }
  }
  const skill = skillToolDefinition({
    description: "Fixture skill",
    displayName: "Fixture skill",
    exposedName: "skill__fixture",
  });
  const connectorDefinition = externalToolDefinition({
    cachedTool: {
      ...connectorTool,
    },
    connectorDisplayName: "Fixture",
  });
  tools.set(skill.name, skill);
  tools.set(connectorDefinition.name, connectorDefinition);
  return [...tools.values()];
};

describe("MCP tool authority census", () => {
  test("every registered tool declares its authority", () => {
    for (const definition of definitions()) {
      if (definition.access === "read") {
        expect(definition.authority.kind).toBeOneOf(["public", "tenant"]);
      } else {
        expect(definition.permissions.type).toBeDefined();
      }
    }
  });

  test("tenant reads require their declared effective authority", () => {
    const tenantReads = definitions().filter(
      (definition) =>
        definition.access === "read" && definition.authority.kind === "tenant",
    );
    expect(tenantReads.length).toBeGreaterThan(0);

    for (const definition of tenantReads) {
      const narrowed = asTestRaw<McpRequestContext>({
        memberRole: "owner",
        credentialPermissions: { timeEntry: ["read"] },
      });
      expect(hasMcpToolAuthority(narrowed, definition)).toBeFalse();
      expect(
        mcpToolAuthorityRefusal({
          authority: narrowed,
          definition,
          toolName: definition.name,
          userEmail: "member@example.test",
        })?.code,
      ).toBe("permission_denied");
      expect(
        hasMcpToolAuthority(
          {
            memberRole: "owner",
            credentialPermissions:
              definition.access === "read" &&
              definition.authority.kind === "tenant"
                ? definition.authority.permissions
                : undefined,
          },
          definition,
        ),
      ).toBeTrue();
    }
  });

  test("offers and runs connector tools by their declared permissions", async () => {
    const listed = await listGatewayMcpToolDefinitions({
      context: narrowedContext,
      mode: "advanced",
      scopes: narrowedContext.grantedScopes,
      externalGatewayDependencies: connectorDependencies,
    });
    expect(
      listed.some(({ name }) => name === connectorTool.exposedName),
    ).toBeFalse();

    const called = await callGatewayExternalMcpTool({
      args: {},
      context: narrowedContext,
      definitionFor: externalToolDefinition,
      dependencies: connectorDependencies,
      toolName: connectorTool.exposedName,
    });
    expect(called.isError).toBeTrue();
    expect(called.content.at(0)).toMatchObject({
      type: "text",
      text: expect.stringContaining("permission_denied"),
    });
  });
});
