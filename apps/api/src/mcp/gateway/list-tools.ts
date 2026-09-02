import type { Tool as McpTool } from "@modelcontextprotocol/server";

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
  McpToolAccessBranch,
  McpToolDefinition,
  McpToolFeatureFlag,
  McpToolInputSchema,
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
const externalMcpToolAccess = ({
  readOnlyHint,
  title,
}: {
  readOnlyHint: boolean | undefined;
  title: string;
}): McpToolAccessBranch =>
  readOnlyHint === true
    ? { access: "read", annotations: { title, readOnlyHint: true } }
    : {
        access: "write",
        annotations: {
          title,
          ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
        },
      };

const LOOKUP_BUSINESS_REGISTRY_TOOL_NAME = "lookup_business_registry";

const isStaticToolVisibleToRole = (
  context: McpRequestContext,
  definition: McpToolDefinition,
): boolean => {
  if (definition.isVisibleToMemberRole === undefined) {
    return true;
  }

  return definition.isVisibleToMemberRole(context.memberRole);
};

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
  // Visibility is keyed to the primary scope only. Compound tools must remain
  // discoverable when an additional grant is missing so MCP clients can call
  // them and receive the complete OAuth recovery hint. The CLI independently
  // retains baked compound commands across scoped registry refreshes, keeping
  // its local all-scopes preflight reachable when the primary grant is absent.
  const staticDefinitions = listStaticMcpToolDefinitions(mode).filter(
    (definition) =>
      hasGrantedScope(scopes, definition.scope) &&
      isMcpToolFeatureEnabled(definition.feature) &&
      isStaticToolVisibleToRole(context, definition),
  );
  // Every restricted surface is a pure static projection. Per-org registry
  // narrowing and dynamic connector/skill discovery run only on the default
  // surface, so a restricted client never discovers a tool its dispatcher
  // rejects and never receives tenant-specific connector metadata.
  if (mode !== "default") {
    return staticDefinitions;
  }
  const definitions = narrowBusinessRegistryTool(context, staticDefinitions);

  if (hasGrantedScope(scopes, "stella:external_mcps")) {
    for (const tool of await listGatewayExternalMcpTools({ context })) {
      definitions.push({
        ...externalMcpToolAccess({
          readOnlyHint: tool.cachedTool.readOnlyHint,
          title: externalToolTitle({
            connectorDisplayName: tool.connectorDisplayName,
            rawName: tool.cachedTool.rawName,
          }),
        }),
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
        annotations: {
          title: toDynamicToolTitle(skill.name) || skill.exposedName,
          readOnlyHint: true,
        },
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
  if (staticTool) {
    return isStaticToolVisibleToRole(context, staticTool)
      ? staticTool
      : undefined;
  }
  if (mode !== "default") {
    return undefined;
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
      ...externalMcpToolAccess({
        readOnlyHint: externalTool.cachedTool.readOnlyHint,
        title: externalToolTitle({
          connectorDisplayName: externalTool.connectorDisplayName,
          rawName: externalTool.cachedTool.rawName,
        }),
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
    annotations: {
      title: toDynamicToolTitle(skill.name) || skill.exposedName,
      readOnlyHint: true,
    },
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

type WireInputSchema = McpTool["inputSchema"];
type WireValue = NonNullable<WireInputSchema["properties"]>[string];

/**
 * A definition authors its schema as the SDK's JSON Schema *interface*, whose
 * schema-valued keywords (`properties`, `$defs`, `items`, ...) are a recursive
 * union that includes the bare `true`/`false` schema JSON Schema permits. The
 * wire type is the same data as plain JSON. Rebuilding the value is what makes
 * the two line up without asserting one onto the other.
 */
const toWireValue = (value: unknown): WireValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("MCP tool input schema contains a non-JSON value");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => toWireValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]: [string, unknown]) => [
        key,
        toWireValue(nested),
      ]),
    );
  }
  // Reject instead of silently changing the schema contract. In particular,
  // replacing an unsupported member with null can turn `description`,
  // `properties`, `$defs`, or `items` into an invalid keyword value.
  throw new TypeError("MCP tool input schema contains a non-JSON value");
};

const convertInputSchema = (schema: McpToolInputSchema): WireInputSchema => {
  const converted = Object.fromEntries(
    Object.entries(schema).map(([key, value]: [string, unknown]) => [
      key,
      toWireValue(value),
    ]),
  );

  // Pinned rather than carried over: the wire type requires the literal, and
  // every tool input is an object schema by construction.
  return { ...converted, type: "object" };
};

/**
 * Tool definitions are static values, so the rebuilt schema is memoized on the
 * definition's own schema object: `tools/list` pays the walk once per tool
 * rather than once per request. Dynamic gateway tools build a fresh schema each
 * time and simply miss, which costs no more than converting inline.
 */
const wireInputSchemas = new WeakMap<McpToolInputSchema, WireInputSchema>();

const toWireInputSchema = (schema: McpToolInputSchema): WireInputSchema => {
  const cached = wireInputSchemas.get(schema);
  if (cached) {
    return cached;
  }

  const converted = convertInputSchema(schema);
  wireInputSchemas.set(schema, converted);
  return converted;
};

export const toMcpTools = (
  definitions: readonly McpToolDefinition[],
): McpTool[] =>
  definitions.map(({ _meta, annotations, description, inputSchema, name }) => ({
    ...(_meta === undefined ? {} : { _meta }),
    annotations,
    description,
    inputSchema: toWireInputSchema(inputSchema),
    name,
    title: annotations.title,
  }));

// Display title for a dynamically-gated tool. External connectors and skills
// carry human names already; clamp to the CLI trust boundary's 64-char wire
// cap (MAX_TOOL_TITLE_CHARS in packages/cli/src/registry-trust.ts) so a long
// connector or skill name cannot make the served listing fail a client's
// fetched-registry validation.
const DYNAMIC_TOOL_TITLE_MAX_CHARS = 64;

// The budget counts UTF-16 units (that is what the trust boundary measures),
// but the cut advances by code point so a boundary can never emit a lone
// surrogate.
const clampTitle = (raw: string, maxUnits: number): string => {
  const trimmed = raw.trim();
  if (trimmed.length <= maxUnits) {
    return trimmed;
  }
  let clamped = "";
  for (const point of trimmed) {
    if (clamped.length + point.length > maxUnits) {
      break;
    }
    clamped += point;
  }
  return clamped.trimEnd();
};

const toDynamicToolTitle = (raw: string): string =>
  clampTitle(raw, DYNAMIC_TOOL_TITLE_MAX_CHARS);

// `<connector display name>: <upstream tool name>`, preferring the tool name:
// connector display names can be far longer than the cap, and truncating the
// combined string from the right would leave every tool of such a connector
// with the same title. The distinguishing suffix keeps its budget first; the
// display-name prefix gets whatever remains.
const EXTERNAL_TITLE_SEPARATOR = ": ";

const externalToolTitle = ({
  connectorDisplayName,
  rawName,
}: {
  connectorDisplayName: string;
  rawName: string;
}): string => {
  const name = toDynamicToolTitle(rawName);
  const displayBudget =
    DYNAMIC_TOOL_TITLE_MAX_CHARS -
    name.length -
    EXTERNAL_TITLE_SEPARATOR.length;
  if (displayBudget <= 0) {
    return name;
  }
  const display = clampTitle(connectorDisplayName, displayBudget);
  if (display.length === 0) {
    return name;
  }
  return `${display}${EXTERNAL_TITLE_SEPARATOR}${name}`;
};

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
