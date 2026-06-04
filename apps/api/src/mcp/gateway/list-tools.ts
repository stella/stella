import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  listGatewayExternalMcpTools,
  resolveGatewayExternalMcpTool,
} from "@/api/mcp/gateway/external-tools";
import {
  loadVisibleSkillTools,
  resolveSkillTool,
} from "@/api/mcp/gateway/skills";
import {
  getStaticMcpToolDefinition,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";

export const listGatewayMcpToolDefinitions = async ({
  context,
  mode,
  scopes,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes?: readonly string[];
}): Promise<McpToolDefinition[]> => {
  const definitions = listStaticMcpToolDefinitions(mode).filter((definition) =>
    hasGrantedScope(scopes, definition.scope),
  );
  if (mode === "anonymized") {
    return definitions;
  }

  if (hasGrantedScope(scopes, "stella:external_mcps")) {
    for (const tool of await listGatewayExternalMcpTools({ context })) {
      definitions.push({
        ...(tool.cachedTool.readOnlyHint === undefined
          ? {}
          : { annotations: { readOnlyHint: tool.cachedTool.readOnlyHint } }),
        description: externalToolDescription({
          connectorDisplayName: tool.connectorDisplayName,
          description: tool.cachedTool.description,
        }),
        inputSchema: tool.cachedTool.inputSchema,
        name: tool.cachedTool.exposedName,
        scope: "stella:external_mcps",
      });
    }
  }

  if (hasGrantedScope(scopes, "stella:skills")) {
    for (const skill of await loadVisibleSkillTools({ context })) {
      definitions.push({
        annotations: { readOnlyHint: true },
        description: skill.description,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        name: skill.exposedName,
        scope: "stella:skills",
      });
    }
  }

  return definitions;
};

export const getGatewayMcpToolDefinition = async ({
  context,
  mode,
  toolName,
}: {
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
}): Promise<McpToolDefinition | undefined> => {
  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  if (staticTool || mode === "anonymized") {
    return staticTool;
  }

  if (isExternalMcpToolName(toolName)) {
    const externalTool = await resolveGatewayExternalMcpTool({
      context,
      toolName,
    });
    if (!externalTool) {
      return undefined;
    }

    return {
      ...(externalTool.cachedTool.readOnlyHint === undefined
        ? {}
        : {
            annotations: {
              readOnlyHint: externalTool.cachedTool.readOnlyHint,
            },
          }),
      description: externalToolDescription({
        connectorDisplayName: externalTool.connectorDisplayName,
        description: externalTool.cachedTool.description,
      }),
      inputSchema: externalTool.cachedTool.inputSchema,
      name: externalTool.cachedTool.exposedName,
      scope: "stella:external_mcps",
    };
  }

  if (!isSkillToolName(toolName)) {
    return undefined;
  }

  const skill = await resolveSkillTool({ context, toolName });
  if (!skill) {
    return undefined;
  }

  return {
    annotations: { readOnlyHint: true },
    description: skill.description,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    name: skill.exposedName,
    scope: "stella:skills",
  };
};

export const toMcpTools = (
  definitions: readonly McpToolDefinition[],
): McpTool[] =>
  definitions.map(({ annotations, description, inputSchema, name }) =>
    annotations === undefined
      ? { description, inputSchema, name }
      : { annotations, description, inputSchema, name },
  );

const externalToolDescription = ({
  connectorDisplayName,
  description,
}: {
  connectorDisplayName: string;
  description?: string | undefined;
}): string =>
  description && description.trim().length > 0
    ? `${connectorDisplayName}: ${description}`
    : `Tool from ${connectorDisplayName}`;

const hasGrantedScope = (
  grantedScopes: readonly string[] | undefined,
  scope: ToolScope,
): boolean => grantedScopes === undefined || grantedScopes.includes(scope);
