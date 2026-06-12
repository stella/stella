import type { AnyToolDefinition } from "@tanstack/ai-mcp";

import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";

export type ExternalMcpToolDefinitions = readonly AnyToolDefinition[];

type ExternalMcpToolDefinitionConnector = Pick<
  LoadedMcpConnection,
  "allowedTools" | "slug"
>;

const EXTERNAL_MCP_TOOL_DEFINITIONS_BY_SLUG: Readonly<
  Record<string, ExternalMcpToolDefinitions>
> = {
  // Curated/high-value MCP connectors belong here once their generated
  // tanstack-ai-mcp descriptors and explicit toolDefinition(...) schemas are
  // checked in. User-added MCP servers intentionally stay dynamic.
};

export const getExternalMcpToolDefinitionsForConnector = ({
  slug,
}: Pick<
  ExternalMcpToolDefinitionConnector,
  "slug"
>): ExternalMcpToolDefinitions | null =>
  EXTERNAL_MCP_TOOL_DEFINITIONS_BY_SLUG[slug] ?? null;

export const selectAllowedExternalMcpToolDefinitions = ({
  allowedTools,
  definitions,
}: {
  allowedTools: ExternalMcpToolDefinitionConnector["allowedTools"];
  definitions: ExternalMcpToolDefinitions;
}): ExternalMcpToolDefinitions => {
  if (allowedTools === null) {
    return definitions;
  }

  const allowedToolNames = new Set(allowedTools);
  return definitions.filter((definition) =>
    allowedToolNames.has(definition.name),
  );
};
