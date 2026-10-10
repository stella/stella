import type { Tool as McpTool } from "@modelcontextprotocol/server";
import { panic } from "better-result";

import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpFeatureAccessContext } from "@/api/mcp/feature-access";
import {
  isMcpDescriptorFeatureEnabled,
  resolveMcpDescriptorFeatureId,
} from "@/api/mcp/feature-access";
import {
  hiddenMcpDescriptorIds,
  scopeMcpDescriptorProse,
  scopeSchemaAnnotations,
} from "@/api/mcp/feature-access-prose";
import {
  getDynamicMcpToolOutputContract,
  SKILL_TOOL_ANNOTATIONS,
  SKILL_TOOL_INPUT,
} from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  listGatewayExternalMcpTools,
  resolveGatewayExternalMcpTool,
} from "@/api/mcp/gateway/external-tools";
import type {
  ExternalGatewayDependencies,
  ResolvedExternalMcpTool,
} from "@/api/mcp/gateway/external-tools";
import {
  GATEWAY_TOOL_KIND,
  modeAllowsGatewayTools,
} from "@/api/mcp/gateway/mode-policy";
import {
  loadVisibleSkillTools,
  resolveSkillTool,
} from "@/api/mcp/gateway/skills";
import type { ResolvedSkillTool } from "@/api/mcp/gateway/skills";
import {
  hasGrantedScope,
  isStaticToolShownToMemberRole,
  listOfferedStaticMcpToolDefinitions,
} from "@/api/mcp/gateway/static-tool-visibility";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
  getStaticMcpToolOutputContract,
} from "@/api/mcp/static-tool-definitions";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";
import type {
  McpAnonymizedPolicy,
  McpToolDefinition,
  McpToolInputSchema,
  McpToolAnnotations,
  RuntimeMcpToolOutputContract,
} from "@/api/mcp/tool-types";
import {
  mcpToolAuthorityRefusal,
  type McpWriteToolPermissions,
} from "@/api/mcp/write-tool-authority";

// The gate's one owner is `mcp/tool-feature.ts`, so the resource list and the
// connect-time instructions apply the same predicate without importing the
// tool registry. Re-exported here because every existing caller of the tool
// surface reaches it through this module.
export { isMcpToolFeatureEnabled };

// Skills and external connector tools are resolved by the dynamic gateway;
// they are never part of the anonymized projection.
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
}):
  | {
      access: "read";
      readClass: "tenant";
      annotations: McpToolAnnotations & {
        destructiveHint: false;
        readOnlyHint: true;
      };
      destructiveBehavior?: undefined;
    }
  | {
      access: "write";
      annotations: McpToolAnnotations & {
        destructiveHint: true;
        readOnlyHint: false;
      };
      destructiveBehavior: { type: "upstream" };
      permissions: McpWriteToolPermissions;
      accountAccess: "account-control";
    } =>
  readOnlyHint === true
    ? {
        access: "read",
        readClass: "tenant",
        annotations: {
          title,
          destructiveHint: false,
          openWorldHint: true,
          readOnlyHint: true,
        },
      }
    : {
        access: "write",
        annotations: {
          title,
          destructiveHint: true,
          openWorldHint: true,
          readOnlyHint: false,
        },
        destructiveBehavior: { type: "upstream" },
        permissions: {
          type: "delegated",
          reason:
            "The connector's upstream server authorizes the call under the connection's own credentials.",
        },
        // Connector administration is reserved to standard accounts over
        // REST; a connector's tools follow it.
        accountAccess: "account-control",
      };

const projectFeatureToolDefinition = (
  definition: McpToolDefinition,
  context: McpRequestContext,
) => {
  const featureId = resolveMcpDescriptorFeatureId({
    context,
    kind: "tools",
    id: definition.name,
    featureId: definition.featureId,
  });
  return featureId === undefined
    ? definition
    : { ...definition, _meta: { ...definition._meta, featureId } };
};

export const listGatewayMcpToolDefinitions = async ({
  context,
  mode,
  scopes,
  externalGatewayDependencies,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes?: readonly string[];
  externalGatewayDependencies?: ExternalGatewayDependencies;
}): Promise<McpToolDefinition[]> => {
  const definitions = listOfferedStaticMcpToolDefinitions({
    context,
    mode,
    scopes,
  }).map((definition) => projectFeatureToolDefinition(definition, context));
  // Restricted surfaces are pure static projections. Dynamic
  // connector discovery runs only on the advanced surface, so a
  // restricted client never discovers a tool its dispatcher rejects and never
  // receives tenant-specific connector metadata.
  if (!modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.skill)) {
    return definitions;
  }

  if (
    modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.externalMcp) &&
    hasGrantedScope(scopes, "stella:external_mcps")
  ) {
    for (const tool of await listGatewayExternalMcpTools({
      context,
      ...(externalGatewayDependencies === undefined
        ? {}
        : { dependencies: externalGatewayDependencies }),
    })) {
      definitions.push(externalToolDefinition(tool));
    }
  }

  if (hasGrantedScope(scopes, "stella:skills")) {
    for (const skill of await loadVisibleSkillTools({ context, scopes })) {
      definitions.push(skillToolDefinition(skill));
    }
  }

  return definitions
    .filter((definition) =>
      isMcpDescriptorFeatureEnabled({
        context,
        kind: "tools",
        id: definition.name,
        featureId: definition.featureId,
      }),
    )
    .map((definition) => projectFeatureToolDefinition(definition, context));
};

export const getGatewayMcpToolDefinition = async ({
  context,
  mode,
  toolName,
  externalGatewayDependencies,
}: {
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
  externalGatewayDependencies?: ExternalGatewayDependencies;
}): Promise<McpToolDefinition | undefined> => {
  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  if (staticTool) {
    // Keep role refusals reachable over HTTP before the enrolment lookup;
    // authorized callers still see an unenrolled tool as unknown.
    if (
      mcpToolAuthorityRefusal({
        authority: context,
        definition: staticTool,
        toolName,
        userEmail: context.userEmail,
      }) !== null
    ) {
      return staticTool;
    }
    return isStaticToolShownToMemberRole(context, staticTool) &&
      isMcpDescriptorFeatureEnabled({
        context,
        kind: "tools",
        id: staticTool.name,
        featureId: staticTool.featureId,
      })
      ? staticTool
      : undefined;
  }
  if (
    !modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.skill) ||
    !isMcpDescriptorFeatureEnabled({ context, kind: "tools", id: toolName })
  ) {
    return undefined;
  }

  if (isExternalMcpToolName(toolName)) {
    if (
      !modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.externalMcp) ||
      !hasGrantedScope(context.grantedScopes, "stella:external_mcps")
    ) {
      return undefined;
    }
    const externalTool = await resolveGatewayExternalMcpTool({
      context,
      toolName,
      ...(externalGatewayDependencies === undefined
        ? {}
        : { dependencies: externalGatewayDependencies }),
    });
    return externalTool === null
      ? undefined
      : externalToolDefinition(externalTool);
  }

  if (!isSkillToolName(toolName)) {
    return undefined;
  }

  const skill = await resolveSkillTool({ context, toolName });
  return skill === null ? undefined : skillToolDefinition(skill);
};

/**
 * A third-party connector tool is served exactly as its upstream declared it:
 * the cached input schema, the upstream read-only hint (trusted only when
 * asserted), and no Stella output contract. The gateway relays its output as
 * text, so no `outputSchema` is advertised on the upstream's behalf.
 */
export const externalToolDefinition = ({
  cachedTool,
  connectorDisplayName,
}: Pick<
  ResolvedExternalMcpTool,
  "cachedTool" | "connectorDisplayName"
>): McpToolDefinition => ({
  ...externalMcpToolAccess({
    readOnlyHint: cachedTool.readOnlyHint,
    title: externalToolTitle({
      connectorDisplayName,
      rawName: cachedTool.rawName,
    }),
  }),
  annotationReasons: {
    readOnlyHint:
      "Only an explicit upstream read-only assertion classifies the connector tool as a read.",
    destructiveHint:
      "Unverified upstream writes may modify or delete existing data.",
    openWorldHint: "The connector executes against an external service.",
  },
  anonymized: DYNAMIC_GATEWAY_ANONYMIZED,
  consumesServices: true,
  description: externalToolDescription({
    connectorDisplayName,
    description: cachedTool.description,
  }),
  inputSchema: cachedTool.inputSchema,
  name: cachedTool.exposedName,
  scope: "stella:external_mcps",
});

/**
 * Every skill tool is the same read of a stored skill, so one definition
 * shape covers the family: the exposed name and title vary per skill, while
 * the annotations and the input and output contracts come from the family
 * policy.
 */
export const skillToolDefinition = (
  skill: Pick<ResolvedSkillTool, "description" | "displayName" | "exposedName">,
): McpToolDefinition => ({
  access: "read",
  readClass: "tenant",
  annotations: {
    ...SKILL_TOOL_ANNOTATIONS,
    title: toDynamicToolTitle(skill.displayName) || skill.exposedName,
  },
  annotationReasons: {
    readOnlyHint: "Reads the stored skill without modifying it.",
    destructiveHint: "Skill content retrieval changes no existing data.",
    openWorldHint: "Reads only stored skill content.",
  },
  anonymized: DYNAMIC_GATEWAY_ANONYMIZED,
  consumesServices: true,
  description: skill.description,
  inputSchema: SKILL_TOOL_INPUT.inputSchema,
  name: skill.exposedName,
  scope: "stella:skills",
});

/**
 * The executable output contract a served tool name is bound to: a static
 * tool's own contract, a Stella-owned dynamic family's shared contract, or
 * none for a third-party connector tool, whose output is relayed as text.
 * `tools/list` and dispatch both resolve through here so the advertised
 * schema and the runtime validator cannot come from different sources.
 */
export const resolveMcpToolOutputContract = (
  toolName: string,
  mode: McpMode = "default",
): RuntimeMcpToolOutputContract | undefined =>
  getStaticMcpToolOutputContract(toolName, mode) ??
  getDynamicMcpToolOutputContract(toolName);

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
      return panic("MCP tool input schema contains a non-JSON value");
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
  return panic("MCP tool input schema contains a non-JSON value");
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
  {
    mode = "default",
    context,
  }: { mode?: McpMode; context?: McpFeatureAccessContext } = {},
): McpTool[] => {
  const hiddenIds = hiddenMcpDescriptorIds(
    context,
    DEFAULT_MCP_TOOL_DEFINITIONS,
  );
  return definitions.map(
    ({ _meta, annotations, description, inputSchema, name }) => {
      const outputContract = resolveMcpToolOutputContract(name, mode);
      return {
        ...(_meta === undefined ? {} : { _meta }),
        annotations,
        description: scopeMcpDescriptorProse(description, hiddenIds),
        inputSchema:
          hiddenIds.size === 0
            ? toWireInputSchema(inputSchema)
            : toWireInputSchema({
                ...scopeSchemaAnnotations(inputSchema, hiddenIds),
                type: "object",
              }),
        name,
        ...(outputContract === undefined
          ? {}
          : {
              outputSchema:
                hiddenIds.size === 0
                  ? outputContract.outputSchema
                  : toWireInputSchema({
                      ...scopeSchemaAnnotations(
                        outputContract.outputSchema,
                        hiddenIds,
                      ),
                      type: "object",
                    }),
            }),
        title: annotations.title,
      };
    },
  );
};

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
