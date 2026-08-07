import { unreachable } from "@/api/lib/errors/tagged-errors";
import { BILLING_TOOL_SET } from "@/api/mcp/billing-tools";
import { CAPABILITY_TOOL_SET } from "@/api/mcp/capability-tools";
import { COMPAT_TOOL_SET } from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import { DOCUMENT_TOOL_SET } from "@/api/mcp/document-tools";
import { FEEDBACK_TOOL_SET } from "@/api/mcp/feedback-tools";
import { KNOWLEDGE_TOOL_SET } from "@/api/mcp/knowledge-tools";
import { MATTER_TOOL_SET } from "@/api/mcp/matter-tools";
import { RESEARCH_ADMIN_TOOL_SET } from "@/api/mcp/research-admin-tools";
import { STELLA_TOOL_SET } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_SET } from "@/api/mcp/template-tools";
import type {
  McpToolDefinition,
  McpToolSet,
  ToolScope,
} from "@/api/mcp/tool-types";

export const DEFAULT_MCP_TOOL_SETS = [
  COMPAT_TOOL_SET,
  STELLA_TOOL_SET,
  TEMPLATE_TOOL_SET,
  DOCUMENT_TOOL_SET,
  MATTER_TOOL_SET,
  KNOWLEDGE_TOOL_SET,
  BILLING_TOOL_SET,
  RESEARCH_ADMIN_TOOL_SET,
  FEEDBACK_TOOL_SET,
  CAPABILITY_TOOL_SET,
] as const satisfies readonly McpToolSet<readonly McpToolDefinition[]>[];

/**
 * The single MCP tool registry. Every mode-specific surface (default list,
 * anonymized projection, scopes) is derived from this one array, so adding a
 * tool without an anonymization decision is a compile error, not a review
 * catch.
 */
export const DEFAULT_MCP_TOOL_DEFINITIONS = [
  ...COMPAT_TOOL_SET.definitions,
  ...STELLA_TOOL_SET.definitions,
  ...TEMPLATE_TOOL_SET.definitions,
  ...DOCUMENT_TOOL_SET.definitions,
  ...MATTER_TOOL_SET.definitions,
  ...KNOWLEDGE_TOOL_SET.definitions,
  ...BILLING_TOOL_SET.definitions,
  ...RESEARCH_ADMIN_TOOL_SET.definitions,
  ...FEEDBACK_TOOL_SET.definitions,
  ...CAPABILITY_TOOL_SET.definitions,
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

const toAnonymizedScope = (toolName: string, scope: ToolScope): ToolScope =>
  ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE[scope] ??
  unreachable(
    `Tool ${toolName} is exposed in anonymized mode but scope ${scope} has no anonymized pairing`,
  );

const toAnonymizedProjection = (
  tool: McpToolDefinition,
): McpToolDefinition | null => {
  if (tool.anonymized.exposure === "excluded") {
    return null;
  }

  const anonymizedScope = toAnonymizedScope(tool.name, tool.scope);
  const additionalScopes = tool.additionalScopes?.map((scope) =>
    toAnonymizedScope(tool.name, scope),
  );

  const description =
    tool.anonymized.exposure === "anonymize" &&
    tool.anonymized.description !== undefined
      ? tool.anonymized.description
      : tool.description;

  return {
    ...tool,
    ...(additionalScopes === undefined ? {} : { additionalScopes }),
    description,
    scope: anonymizedScope,
  };
};

export const ANONYMIZED_MCP_TOOL_DEFINITIONS =
  DEFAULT_MCP_TOOL_DEFINITIONS.flatMap((tool) => {
    const projected = toAnonymizedProjection(tool);
    return projected === null ? [] : [projected];
  }) satisfies readonly McpToolDefinition[];

const DEFAULT_MCP_TOOL_DEFINITIONS_WIDE: readonly McpToolDefinition[] =
  DEFAULT_MCP_TOOL_DEFINITIONS;

const DOCUMENTS_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DOCUMENT_TOOL_SET.definitions.map(({ name }) => name),
  // The upload MCP App drives the canonical presign/PUT/finalize pipeline
  // through this existing capability seam. tools.ts applies a mode-specific
  // capability allowlist, so guessed non-upload capability IDs fail closed.
  "invoke_capability",
]);

/** Projection from the canonical registry; no host-specific tool copies. */
export const DOCUMENTS_MCP_TOOL_DEFINITIONS =
  DEFAULT_MCP_TOOL_DEFINITIONS_WIDE.filter(({ name }) =>
    DOCUMENTS_MCP_TOOL_NAMES.has(name),
  ) satisfies readonly McpToolDefinition[];

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
  documents: new Map<string, McpToolDefinition>(
    DOCUMENTS_MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  ),
} satisfies Record<McpMode, Map<string, McpToolDefinition>>;

export const getStaticMcpToolDefinition = (
  toolName: string,
  mode: McpMode = "default",
) => MCP_TOOL_DEFINITION_MAPS[mode].get(toolName);

export const listStaticMcpToolDefinitions = (
  mode: McpMode = "default",
): readonly McpToolDefinition[] => {
  if (mode === "default") {
    return DEFAULT_MCP_TOOL_DEFINITIONS;
  }
  if (mode === "documents") {
    return DOCUMENTS_MCP_TOOL_DEFINITIONS;
  }
  return ANONYMIZED_MCP_TOOL_DEFINITIONS;
};
