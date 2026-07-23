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
  McpToolAccess,
  McpToolDefinition,
  McpToolFeatureFlag,
  ToolScope,
} from "@/api/mcp/tool-types";
import { enumProp } from "@/api/mcp/tool-utils";

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

/**
 * An external MCP connector is a third party server we do not control, so its
 * own `readOnlyHint` (an optional, unverified client hint per the MCP spec)
 * is the only signal available. Trust it only when the connector explicitly
 * asserts `true`; treat `false` or an absent hint as `"write"` so an
 * unverified external tool never structurally qualifies for a surface (like
 * the chat code-mode projection) that assumes `"read"` means safe-to-run
 * without confirmation.
 */
const externalMcpToolAccess = (
  readOnlyHint: boolean | undefined,
): McpToolAccess => (readOnlyHint === true ? "read" : "write");

const LOOKUP_BUSINESS_REGISTRY_TOOL_NAME = "lookup_business_registry";

/**
 * Narrow the `lookup_business_registry` tool's `registry` enum to the
 * registries this org can actually reach (`context.enabledRegistrySlugs`,
 * resolved once at context bootstrap), and drop the tool entirely when none
 * are. Mirrors the in-app chat tool, so the external MCP surface can no longer
 * advertise a registry whose call-time gate would 403 — the same defect the
 * chat tool already avoids. Applied only to the default surface; the
 * anonymized projection stays tenant-neutral and is never narrowed.
 *
 * `enabledRegistrySlugs === undefined` means the set was not resolved (a
 * synthetic/test context, or a bootstrap settings-read fault): leave the full
 * enum advertised and let the call-time gate stay the backstop.
 */
const narrowBusinessRegistryTool = (
  context: McpRequestContext,
  definitions: McpToolDefinition[],
): McpToolDefinition[] => {
  const enabledSlugs = context.enabledRegistrySlugs;
  if (enabledSlugs === undefined) {
    return definitions;
  }

  const index = definitions.findIndex(
    (definition) => definition.name === LOOKUP_BUSINESS_REGISTRY_TOOL_NAME,
  );
  const definition = definitions[index];
  if (definition === undefined) {
    return definitions;
  }

  if (enabledSlugs.length === 0) {
    return definitions.filter((_definition, i) => i !== index);
  }

  return definitions.map((current, i) =>
    i === index
      ? {
          ...definition,
          inputSchema: {
            ...definition.inputSchema,
            properties: {
              ...definition.inputSchema.properties,
              registry: enumProp("Business register to query", enabledSlugs),
            },
          },
        }
      : current,
  );
};

export const listGatewayMcpToolDefinitions = async ({
  context,
  mode,
  scopes,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes?: readonly string[];
}): Promise<McpToolDefinition[]> => {
  const staticDefinitions = listStaticMcpToolDefinitions(mode).filter(
    (definition) =>
      hasGrantedScope(scopes, definition.scope) &&
      isMcpToolFeatureEnabled(definition.feature),
  );
  // The anonymized tools/list is a tenant-neutral pure projection (see
  // mcp/README.md): keep every tool's schema intact. Per-org registry
  // narrowing runs only on the default surface, or the anonymized schema
  // would leak the org's practice-jurisdiction / native-tool settings.
  if (mode === "anonymized") {
    return staticDefinitions;
  }
  const definitions = narrowBusinessRegistryTool(context, staticDefinitions);

  if (hasGrantedScope(scopes, "stella:external_mcps")) {
    for (const tool of await listGatewayExternalMcpTools({ context })) {
      const { readOnlyHint } = tool.cachedTool;
      definitions.push({
        access: externalMcpToolAccess(readOnlyHint),
        ...(readOnlyHint === undefined
          ? {}
          : { annotations: { readOnlyHint } }),
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
        access: "read",
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
      access: externalMcpToolAccess(externalTool.cachedTool.readOnlyHint),
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
    access: "read",
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
