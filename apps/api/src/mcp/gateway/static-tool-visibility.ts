import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  projectMcpFeatureInput,
  isMcpDescriptorFeatureEnabled,
} from "@/api/mcp/feature-access";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";
import type { McpToolDefinition, ToolScope } from "@/api/mcp/tool-types";
import { enumProp } from "@/api/mcp/tool-utils";
import { isMcpToolVisibleTo } from "@/api/mcp/tool-visibility";
import {
  hasMcpToolAuthority,
  isAccountAuthorizedForMcpTool,
} from "@/api/mcp/write-tool-authority";

/**
 * A session that cannot confirm is not offered tools that always need
 * confirmation. Discriminator tools stay listed: their other actions run
 * without it, and dispatch refuses only the confirmation-gated ones.
 */
const isStaticToolAvailableToConfirmation = (
  context: McpRequestContext,
  definition: McpToolDefinition,
): boolean => {
  if (context.toolConfirmation !== TOOL_CONFIRMATION.unavailable) {
    return true;
  }
  const behavior = definition.destructiveBehavior?.type;
  return behavior !== "always" && behavior !== "outbound";
};

/**
 * A tool whose definition hides it from a member role outright: absent from
 * discovery and, on a call by name, answered as an unknown tool.
 */
export const isStaticToolShownToMemberRole = (
  context: McpRequestContext,
  definition: McpToolDefinition,
): boolean => definition.isVisibleToMemberRole?.(context.memberRole) ?? true;

/**
 * A write tool is offered only to a request whose effective authority holds
 * its declared permissions and whose account its declared account access
 * admits. A call by name still resolves it, so dispatch answers
 * `permission_denied` naming the member role, the credential, or the account.
 */
const isStaticToolVisibleToRole = (
  context: McpRequestContext,
  definition: McpToolDefinition,
): boolean =>
  hasMcpToolAuthority(context, definition) &&
  isAccountAuthorizedForMcpTool(context.userEmail, definition) &&
  isStaticToolShownToMemberRole(context, definition);

const LOOKUP_BUSINESS_REGISTRY_TOOL_NAME = "lookup_business_registry";

/**
 * Narrow the `lookup_business_registry` tool's `registry` enum to the
 * registries this org can actually reach (`context.enabledRegistrySlugs`,
 * resolved once at context bootstrap), and drop the tool entirely when none
 * are. Mirrors the in-app chat tool, so the external MCP surface can no longer
 * advertise a registry whose call cannot execute — the same defect the chat
 * tool already avoids. Applied only to the default surface; the
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

/**
 * The static tools one session is offered: granted by its scopes, enabled on
 * this deployment, visible to its member role, confirmable by its client, and
 * (on the default surface) narrowed to the business registers its organization
 * can reach. `tools/list` serves these, and a skill is offered over MCP only
 * when every tool it requires is among them. Host discovery omits `audience`
 * so app-only definitions reach hosts with their visibility metadata; model
 * consumers select `audience: "model"`. Audience is never an authorization grant.
 *
 * Visibility is keyed to the primary scope only. Compound tools must remain
 * discoverable when an additional grant is missing so MCP clients can call
 * them and receive the complete OAuth recovery hint. The CLI independently
 * retains baked compound commands across scoped registry refreshes, keeping
 * its local all-scopes preflight reachable when the primary grant is absent.
 */
export const listOfferedStaticMcpToolDefinitions = ({
  context,
  mode,
  scopes,
  audience,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes?: readonly string[] | undefined;
  audience?: "model" | "app";
}): readonly McpToolDefinition[] => {
  const staticDefinitions = listStaticMcpToolDefinitions(mode)
    .map((definition) => projectMcpFeatureInput(context, definition))
    .filter(
      (definition) =>
        (audience === undefined || isMcpToolVisibleTo(definition, audience)) &&
        hasGrantedScope(scopes, definition.scope) &&
        isMcpDescriptorFeatureEnabled({
          context,
          kind: "tools",
          id: definition.name,
          featureId: definition.featureId,
        }) &&
        isMcpToolFeatureEnabled(definition.feature) &&
        isStaticToolVisibleToRole(context, definition) &&
        isStaticToolAvailableToConfirmation(context, definition),
    );
  return mode === "default"
    ? narrowBusinessRegistryTool(context, staticDefinitions)
    : staticDefinitions;
};

/** `undefined` grants every scope (a caller that does not filter by scope). */
export const hasGrantedScope = (
  grantedScopes: readonly string[] | undefined,
  scope: ToolScope,
): boolean => grantedScopes === undefined || grantedScopes.includes(scope);
