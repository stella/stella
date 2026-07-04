import { unreachable } from "@/api/lib/errors/tagged-errors";
import { COMPAT_TOOL_DEFINITIONS } from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import { DOCUMENT_TOOL_DEFINITIONS } from "@/api/mcp/document-tools";
import { MATTER_TOOL_DEFINITIONS } from "@/api/mcp/matter-tools";
import { STELLA_TOOL_DEFINITIONS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_DEFINITIONS } from "@/api/mcp/template-tools";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";

/**
 * The single MCP tool registry. Every mode-specific surface (default list,
 * anonymized projection, scopes) is derived from this one array, so adding a
 * tool without an anonymization decision is a compile error, not a review
 * catch.
 */
export const DEFAULT_MCP_TOOL_DEFINITIONS = [
  ...COMPAT_TOOL_DEFINITIONS,
  ...STELLA_TOOL_DEFINITIONS,
  ...TEMPLATE_TOOL_DEFINITIONS,
  ...DOCUMENT_TOOL_DEFINITIONS,
  ...MATTER_TOOL_DEFINITIONS,
] as const satisfies readonly McpToolDefinition[];

/**
 * The closed set of curated static MCP tool names, derived from the single
 * default registry. Source of truth for the `McpToolName` type
 * (`apps/api/src/lib/api-handlers.ts`, type-only import to avoid a runtime
 * cycle) and for the runtime coverage guard
 * (`apps/api/scripts/mcp-coverage-guard.ts`). Because the registry is
 * declared `as const`, `.map` preserves the literal name union, so
 * `(typeof MCP_STATIC_TOOL_NAMES)[number]` is the exact tool-name union.
 */
export const MCP_STATIC_TOOL_NAMES = DEFAULT_MCP_TOOL_DEFINITIONS.map(
  (tool) => tool.name,
);

/**
 * Default -> anonymized scope remap. A tool available in anonymized mode keeps
 * its schema and (usually) description but is advertised under the paired
 * `stella:*_anonymized` scope so anonymized-mode tokens cannot reach the
 * default surface and vice versa.
 */
// Annotated (not `as const satisfies`) on purpose: the wide `ToolScope` key
// type is what lets the projection look a tool's scope up by value and get
// `ToolScope | undefined` back, instead of erroring on an out-of-set key.
const ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE: Partial<Record<ToolScope, ToolScope>> =
  {
    "stella:search": "stella:search_anonymized",
    "stella:read": "stella:read_anonymized",
    "stella:templates": "stella:templates_anonymized",
  };

const toAnonymizedProjection = (
  tool: McpToolDefinition,
): McpToolDefinition | null => {
  if (tool.anonymized.exposure === "excluded") {
    return null;
  }

  const anonymizedScope =
    ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE[tool.scope] ??
    unreachable(
      `Tool ${tool.name} is exposed in anonymized mode but scope ${tool.scope} has no anonymized pairing`,
    );

  const description =
    tool.anonymized.exposure === "anonymize" &&
    tool.anonymized.description !== undefined
      ? tool.anonymized.description
      : tool.description;

  return {
    ...tool,
    description,
    scope: anonymizedScope,
  };
};

export const ANONYMIZED_MCP_TOOL_DEFINITIONS =
  DEFAULT_MCP_TOOL_DEFINITIONS.flatMap((tool) => {
    const projected = toAnonymizedProjection(tool);
    return projected === null ? [] : [projected];
  }) satisfies readonly McpToolDefinition[];

/**
 * Scopes actually used by the anonymized projection. A test cross-checks this
 * against `MCP_ANONYMIZED_RESOURCE_SCOPES` so no advertised scope is orphaned
 * and no projected scope goes unadvertised.
 */
export const MCP_ANONYMIZED_PROJECTED_SCOPES: readonly ToolScope[] = [
  ...new Set(ANONYMIZED_MCP_TOOL_DEFINITIONS.map((tool) => tool.scope)),
];

const MCP_TOOL_DEFINITION_MAPS = {
  default: new Map<string, McpToolDefinition>(
    DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  ),
  anonymized: new Map<string, McpToolDefinition>(
    ANONYMIZED_MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  ),
} satisfies Record<McpMode, Map<string, McpToolDefinition>>;

export const getStaticMcpToolDefinition = (
  toolName: string,
  mode: McpMode = "default",
) => MCP_TOOL_DEFINITION_MAPS[mode].get(toolName);

export const listStaticMcpToolDefinitions = (
  mode: McpMode = "default",
): readonly McpToolDefinition[] =>
  mode === "default"
    ? DEFAULT_MCP_TOOL_DEFINITIONS
    : ANONYMIZED_MCP_TOOL_DEFINITIONS;
