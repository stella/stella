import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

import { env } from "@/api/env";
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
import type {
  McpAnonymizedPolicy,
  McpToolDefinition,
  McpToolFeatureFlag,
  ToolScope,
} from "@/api/mcp/tool-types";

/**
 * A feature-gated tool is advertised and dispatchable only when its deployment
 * flag is on, mirroring the backing route's own gate (e.g. the case-law public
 * routes use `env.isDev || env.FEATURE_PUBLIC_LAW`). Untagged tools are always
 * available. Dev deployments see every tool so local work is not blocked. This
 * is the single chokepoint the list surface and the dispatch guard share so a
 * gated-off tool can neither be discovered nor invoked by guessing its name.
 */
export const isMcpToolFeatureEnabled = (
  feature: McpToolFeatureFlag | undefined,
): boolean => feature === undefined || env.isDev || env[feature];

// Skills and external connector tools are resolved by the dynamic gateway in
// default mode only; they are never part of the anonymized projection.
const DYNAMIC_GATEWAY_ANONYMIZED = {
  exposure: "excluded",
  reason: "dynamic_gateway",
} as const satisfies McpAnonymizedPolicy;

export const listGatewayMcpToolDefinitions = async ({
  context,
  mode,
  scopes,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes?: readonly string[];
}): Promise<McpToolDefinition[]> => {
  const definitions = listStaticMcpToolDefinitions(mode).filter(
    (definition) =>
      hasGrantedScope(scopes, definition.scope) &&
      isMcpToolFeatureEnabled(definition.feature),
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
        anonymized: DYNAMIC_GATEWAY_ANONYMIZED,
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
        anonymized: DYNAMIC_GATEWAY_ANONYMIZED,
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
      anonymized: DYNAMIC_GATEWAY_ANONYMIZED,
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
    anonymized: DYNAMIC_GATEWAY_ANONYMIZED,
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
