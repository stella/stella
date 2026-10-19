import { describe, expect, test } from "bun:test";

import { MCP_MODES } from "@/api/mcp/constants";
import {
  externalToolDefinition,
  skillToolDefinition,
} from "@/api/mcp/gateway/list-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import {
  hasMcpToolAuthority,
  mcpToolAuthorityRefusal,
} from "@/api/mcp/tool-authority";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

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
  const connector = externalToolDefinition({
    cachedTool: {
      exposedName: "mcp__fixture__read",
      inputSchema: { type: "object", properties: {} },
      rawName: "read",
      readOnlyHint: true,
    },
    connectorDisplayName: "Fixture",
  });
  tools.set(skill.name, skill);
  tools.set(connector.name, connector);
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
      const narrowed = {
        memberRole: "owner" as const,
        credentialPermissions: { timeEntry: ["read"] as const },
      };
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
            credentialPermissions: definition.authority.permissions,
          },
          definition,
        ),
      ).toBeTrue();
    }
  });
});
