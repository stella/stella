import type { McpDefaultResourceScope } from "@stll/api-contract";

import { unreachable } from "@/api/lib/errors/tagged-errors";
import { BILLING_TOOL_SET } from "@/api/mcp/billing-tools";
import { CAPABILITY_TOOL_SET } from "@/api/mcp/capability-tools";
import { LAW_COMPAT_TOOL_SET } from "@/api/mcp/compat-law-tools";
import { COMPAT_TOOL_SET } from "@/api/mcp/compat-tools";
import {
  MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE,
  MCP_DEFAULT_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import { DOCUMENT_TOOL_SET } from "@/api/mcp/document-tools";
import { FEEDBACK_TOOL_SET } from "@/api/mcp/feedback-tools";
import { KNOWLEDGE_TOOL_SET } from "@/api/mcp/knowledge-tools";
import { LEGISLATION_TOOL_SET } from "@/api/mcp/legislation-tools";
import { MATTER_TOOL_SET } from "@/api/mcp/matter-tools";
import { READER_ANNOTATION_TOOL_SET } from "@/api/mcp/reader-annotation-tools";
import { RESEARCH_ADMIN_TOOL_SET } from "@/api/mcp/research-admin-tools";
import { STELLA_TOOL_SET } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_SET } from "@/api/mcp/template-tools";
import type {
  McpToolDefinition,
  McpToolHandler,
  RuntimeMcpToolOutputContract,
  McpToolSet,
  ToolScope,
} from "@/api/mcp/tool-types";

export const DEFAULT_MCP_TOOL_SETS = [
  COMPAT_TOOL_SET,
  STELLA_TOOL_SET,
  LEGISLATION_TOOL_SET,
  TEMPLATE_TOOL_SET,
  DOCUMENT_TOOL_SET,
  MATTER_TOOL_SET,
  KNOWLEDGE_TOOL_SET,
  READER_ANNOTATION_TOOL_SET,
  BILLING_TOOL_SET,
  RESEARCH_ADMIN_TOOL_SET,
  FEEDBACK_TOOL_SET,
  CAPABILITY_TOOL_SET,
] as const satisfies readonly McpToolSet<readonly McpToolDefinition[]>[];

// Keep this schema-sensitive projection as a literal tuple: flattening the
// heterogeneous sets with Array.flatMap widens their definition types and
// destroys the exact tool-name union used throughout chat. The bidirectional
// compile check below makes the explicit projection unable to drift from the
// canonical tool-set registry.
export const DEFAULT_MCP_TOOL_DEFINITIONS = [
  ...COMPAT_TOOL_SET.definitions,
  ...STELLA_TOOL_SET.definitions,
  ...LEGISLATION_TOOL_SET.definitions,
  ...TEMPLATE_TOOL_SET.definitions,
  ...DOCUMENT_TOOL_SET.definitions,
  ...MATTER_TOOL_SET.definitions,
  ...KNOWLEDGE_TOOL_SET.definitions,
  ...READER_ANNOTATION_TOOL_SET.definitions,
  ...BILLING_TOOL_SET.definitions,
  ...RESEARCH_ADMIN_TOOL_SET.definitions,
  ...FEEDBACK_TOOL_SET.definitions,
  ...CAPABILITY_TOOL_SET.definitions,
] as const satisfies readonly McpToolDefinition[];

export type AnonymizingMcpToolName = Extract<
  (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number],
  { anonymized: { exposure: "anonymize" } }
>["name"];

type RegisteredMcpToolName =
  (typeof DEFAULT_MCP_TOOL_SETS)[number]["definitions"][number]["name"];
type FlattenedMcpToolName =
  (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number]["name"];
type MissingMcpToolName = Exclude<RegisteredMcpToolName, FlattenedMcpToolName>;
type ExtraMcpToolName = Exclude<FlattenedMcpToolName, RegisteredMcpToolName>;

true satisfies [MissingMcpToolName, ExtraMcpToolName] extends [never, never]
  ? true
  : never;

type ValibotInputToolName = Extract<
  (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number],
  { inputSchemaSource: unknown }
>["name"];
type LegacyManualInputToolName = Exclude<
  RegisteredMcpToolName,
  ValibotInputToolName
>;

// Every native tool must use defineValibotMcpTool, so no hand-written input schema mirrors a validator.
true satisfies [LegacyManualInputToolName] extends [never] ? true : never;

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
const isMcpDefaultResourceScope = (
  scope: ToolScope,
): scope is McpDefaultResourceScope =>
  MCP_DEFAULT_RESOURCE_SCOPES.some((candidate) => candidate === scope);

const toAnonymizedScope = (toolName: string, scope: ToolScope): ToolScope => {
  if (!isMcpDefaultResourceScope(scope)) {
    return unreachable(
      `Tool ${toolName} is exposed in anonymized mode but scope ${scope} is not a default resource scope`,
    );
  }

  return (
    MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE[scope] ??
    unreachable(
      `Tool ${toolName} is exposed in anonymized mode but scope ${scope} has no anonymized pairing`,
    )
  );
};

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

const invokeCapabilityDefinition = CAPABILITY_TOOL_SET.definitions.find(
  ({ name }) => name === "invoke_capability",
);
if (invokeCapabilityDefinition === undefined) {
  unreachable("The documents MCP surface requires invoke_capability");
}
const DOCUMENT_MCP_TOOL_DEFINITION_SET: ReadonlySet<McpToolDefinition> =
  new Set(DOCUMENT_TOOL_SET.definitions);

/** Projection from the canonical registry; no host-specific tool copies. */
export const DOCUMENTS_MCP_TOOL_DEFINITIONS =
  DEFAULT_MCP_TOOL_DEFINITIONS.filter(
    (tool) =>
      DOCUMENT_MCP_TOOL_DEFINITION_SET.has(tool) ||
      // The upload MCP App drives the canonical presign/PUT/finalize pipeline
      // through this existing capability seam. tools.ts applies a mode-specific
      // capability allowlist, so guessed non-upload capability IDs fail closed.
      tool === invokeCapabilityDefinition,
  ) satisfies readonly McpToolDefinition[];

/**
 * The tool sets only the law audience serves.
 *
 * The OpenAI-compatible pair is on this surface under the same wire names it
 * carries on the default one, and a handler never sees the request mode, so
 * the law audience's `search`/`fetch` are different definitions bound to
 * different handlers rather than the default pair with a branch inside it.
 * They cannot join `DEFAULT_MCP_TOOL_SETS`, whose names are unique.
 */
const LAW_ONLY_MCP_TOOL_SETS = [
  LAW_COMPAT_TOOL_SET,
] as const satisfies readonly McpToolSet<readonly McpToolDefinition[]>[];

const LAW_ONLY_MCP_TOOL_DEFINITIONS = [
  ...LAW_COMPAT_TOOL_SET.definitions,
] as const satisfies readonly McpToolDefinition[];

const LAW_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  LAW_ONLY_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
);

/**
 * Every advertised tool definition, both audiences' copies of a shared wire
 * name included. Registry-wide guards (id formats, null tolerance, string
 * constraints) walk this rather than the default registry, so a tool that only
 * the law audience serves is held to the same contract rules.
 */
export const ALL_MCP_TOOL_DEFINITIONS = [
  ...DEFAULT_MCP_TOOL_DEFINITIONS,
  ...LAW_ONLY_MCP_TOOL_DEFINITIONS,
] as const satisfies readonly McpToolDefinition[];

/**
 * Every tool backed by the shared public legal corpus: the deployment gate and
 * the passthrough egress policy together are what "carries no tenant data"
 * means structurally. The law audience is built from this union, so a new
 * gated corpus tool cannot land without a disposition below.
 */
type PublicLawToolName = Extract<
  (typeof ALL_MCP_TOOL_DEFINITIONS)[number],
  { anonymized: { exposure: "passthrough" }; feature: "FEATURE_PUBLIC_LAW" }
>["name"];

/**
 * What each public-law tool is to the law audience. Total over
 * `PublicLawToolName`, so the compiler names a new corpus tool that has no
 * decision here instead of letting it default onto (or off) the surface.
 */
export const LAW_MCP_TOOL_DISPOSITION = {
  search: "corpus",
  fetch: "corpus",
  search_case_law: "corpus",
  lookup_case_law: "corpus",
  read_case_law_decision: "corpus",
  read_case_law_citations: "corpus",
  search_legislation: "corpus",
  read_statute: "corpus",
  read_statute_provisions: "corpus",
  read_provision_history: "corpus",
  // Excluded deliberately: this one queries a live upstream publisher rather
  // than the stella corpus, so its availability, latency and coverage are not
  // properties of this surface. An agent told "these tools are the corpus"
  // would read an upstream outage as the corpus being down.
  search_boe_legislation: "upstream_connector",
} as const satisfies Record<PublicLawToolName, "corpus" | "upstream_connector">;

type MissingLawMcpToolDisposition = Exclude<
  PublicLawToolName,
  keyof typeof LAW_MCP_TOOL_DISPOSITION
>;
true satisfies MissingLawMcpToolDisposition extends never ? true : never;

const LAW_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(LAW_MCP_TOOL_DISPOSITION)
    .filter(([, disposition]) => disposition === "corpus")
    .map(([name]) => name),
);

/**
 * The law audience's own OpenAI-compatible pair first, then the named corpus
 * tools projected from the canonical registry in registry order. No scope
 * remap: every tool here already reads under `stella:search`/`stella:read`.
 */
export const LAW_MCP_TOOL_DEFINITIONS = [
  ...LAW_ONLY_MCP_TOOL_DEFINITIONS,
  ...DEFAULT_MCP_TOOL_DEFINITIONS.filter(
    (tool) =>
      LAW_MCP_TOOL_NAMES.has(tool.name) &&
      !LAW_ONLY_MCP_TOOL_NAMES.has(tool.name),
  ),
] satisfies readonly McpToolDefinition[];

/**
 * The advertised tool list per audience, in wire order. Total over `McpMode`:
 * a new audience states its projection here rather than inheriting another
 * one's by falling through a conditional.
 */
const MCP_TOOL_DEFINITIONS_BY_MODE = {
  default: DEFAULT_MCP_TOOL_DEFINITIONS,
  anonymized: ANONYMIZED_MCP_TOOL_DEFINITIONS,
  documents: DOCUMENTS_MCP_TOOL_DEFINITIONS,
  law: LAW_MCP_TOOL_DEFINITIONS,
} as const satisfies Record<McpMode, readonly McpToolDefinition[]>;

const toToolDefinitionMap = (definitions: readonly McpToolDefinition[]) =>
  new Map<string, McpToolDefinition>(
    definitions.map((tool) => [tool.name, tool]),
  );

const MCP_TOOL_DEFINITION_MAPS = {
  default: toToolDefinitionMap(MCP_TOOL_DEFINITIONS_BY_MODE.default),
  anonymized: toToolDefinitionMap(MCP_TOOL_DEFINITIONS_BY_MODE.anonymized),
  documents: toToolDefinitionMap(MCP_TOOL_DEFINITIONS_BY_MODE.documents),
  law: toToolDefinitionMap(MCP_TOOL_DEFINITIONS_BY_MODE.law),
} satisfies Record<McpMode, Map<string, McpToolDefinition>>;

const toOutputContractMap = (
  toolSets: readonly McpToolSet<readonly McpToolDefinition[]>[],
) =>
  new Map<string, RuntimeMcpToolOutputContract>(
    toolSets.flatMap((toolSet) => Object.entries(toolSet.outputs)),
  );

const toHandlerMap = (
  toolSets: readonly McpToolSet<readonly McpToolDefinition[]>[],
) =>
  new Map<string, McpToolHandler>(
    toolSets.flatMap((toolSet) => Object.entries(toolSet.handlers)),
  );

/**
 * Handlers and output contracts resolve per audience, not per name alone: two
 * audiences advertise a `search` and a `fetch`, and they are different tools
 * with different contracts. The law audience's own sets are looked up first
 * and the shared registry answers for everything else, so a name it does not
 * override keeps exactly one implementation.
 */
const MCP_TOOL_OUTPUT_CONTRACTS = {
  default: toOutputContractMap(DEFAULT_MCP_TOOL_SETS),
  law: toOutputContractMap(LAW_ONLY_MCP_TOOL_SETS),
} as const;

const MCP_TOOL_HANDLERS = {
  default: toHandlerMap(DEFAULT_MCP_TOOL_SETS),
  law: toHandlerMap(LAW_ONLY_MCP_TOOL_SETS),
} as const;

export const getStaticMcpToolDefinition = (
  toolName: string,
  mode: McpMode = "default",
) => MCP_TOOL_DEFINITION_MAPS[mode].get(toolName);

export const getStaticMcpToolOutputContract = (
  toolName: string,
  mode: McpMode = "default",
) =>
  (mode === "law" ? MCP_TOOL_OUTPUT_CONTRACTS.law.get(toolName) : undefined) ??
  MCP_TOOL_OUTPUT_CONTRACTS.default.get(toolName);

export const getStaticMcpToolHandler = (
  toolName: string,
  mode: McpMode = "default",
) =>
  (mode === "law" ? MCP_TOOL_HANDLERS.law.get(toolName) : undefined) ??
  MCP_TOOL_HANDLERS.default.get(toolName);

export const listStaticMcpToolDefinitions = (
  mode: McpMode = "default",
): readonly McpToolDefinition[] => MCP_TOOL_DEFINITIONS_BY_MODE[mode];
