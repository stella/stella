import { panic } from "better-result";

import { BoundedLruCache } from "@stll/collation";

import {
  hasLawReadScope,
  LAW_READ_SCOPE,
} from "@/api/handlers/legal-resolve/scope";
import type { BusinessRegistrySlug } from "@/api/lib/business-registries/dispatch";
import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestResources } from "@/api/mcp/context";
import {
  isMcpDescriptorFeatureEnabled,
  projectMcpFeatureInput,
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
  context: McpRequestResources,
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
  context: McpRequestResources,
  definition: McpToolDefinition,
): boolean => definition.isVisibleToMemberRole?.(context.memberRole) ?? true;

/**
 * A write tool is offered only to a request whose effective authority holds
 * its declared permissions and whose account its declared account access
 * admits. A call by name still resolves it, so dispatch answers
 * `permission_denied` naming the member role, the credential, or the account.
 */
const isStaticToolVisibleToRole = (
  context: McpRequestResources,
  definition: McpToolDefinition,
): boolean =>
  hasMcpToolAuthority(context, definition) &&
  isAccountAuthorizedForMcpTool(context.userEmail, definition) &&
  isStaticToolShownToMemberRole(context, definition);

const LOOKUP_BUSINESS_REGISTRY_TOOL_NAME = "lookup_business_registry";

/**
 * The registries a session's discovery narrows to: resolved only on the
 * default surface, the one surface that narrows, so no other audience pays the
 * settings read and credential decryption behind it. `undefined` leaves the
 * enum whole; only a read that produced the set narrows it.
 */
export const resolveOfferedRegistrySlugs = async (
  context: McpRequestResources,
  mode: McpMode,
): Promise<readonly BusinessRegistrySlug[] | undefined> => {
  if (mode !== "default" || context.loadEnabledRegistrySlugs === undefined) {
    return undefined;
  }
  const outcome = await context.loadEnabledRegistrySlugs();
  switch (outcome.type) {
    case "present":
      return outcome.value;
    case "absent":
    case "refused":
    case "unavailable":
      return undefined;
    default:
      outcome satisfies never;
      return panic("Unhandled registry read outcome");
  }
};

/**
 * The narrowed definition depends on the definition and the slug set alone,
 * so it is built once per pair: a stable schema object lets `tools/list`
 * reuse its wire conversion instead of rebuilding it on every call.
 */
const NARROWED_REGISTRY_VARIANTS = 16;
const narrowedRegistryDefinitions = new WeakMap<
  McpToolDefinition,
  BoundedLruCache<string, McpToolDefinition>
>();

const narrowRegistryDefinition = (
  definition: McpToolDefinition,
  enabledSlugs: readonly BusinessRegistrySlug[],
): McpToolDefinition => {
  let variants = narrowedRegistryDefinitions.get(definition);
  if (variants === undefined) {
    variants = new BoundedLruCache(NARROWED_REGISTRY_VARIANTS);
    narrowedRegistryDefinitions.set(definition, variants);
  }
  const key = enabledSlugs.join(" ");
  const cached = variants.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const narrowed = deepFreeze({
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...definition.inputSchema.properties,
        registry: enumProp("Business register to query", enabledSlugs),
      },
    },
  });
  variants.set(key, narrowed);
  return narrowed;
};

/**
 * Narrow the `lookup_business_registry` tool's `registry` enum to the
 * registries this org can actually reach, and drop the tool entirely when
 * none are. Mirrors the in-app chat tool, so the external MCP surface can no longer
 * advertise a registry whose call cannot execute — the same defect the chat
 * tool already avoids. Applied only to the default surface; the
 * anonymized projection stays tenant-neutral and is never narrowed.
 *
 * `enabledSlugs === undefined` means the set was not resolved (no loader on a
 * synthetic/test context, or a settings or credential read fault): leave the
 * full enum advertised and let the call-time gate stay the backstop.
 */
const narrowBusinessRegistryTool = (
  enabledSlugs: readonly BusinessRegistrySlug[] | undefined,
  definitions: readonly McpToolDefinition[],
): readonly McpToolDefinition[] => {
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

  const narrowed = narrowRegistryDefinition(definition, enabledSlugs);
  return definitions.map((current, i) => (i === index ? narrowed : current));
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
type OfferedStaticMcpToolOptions = {
  context: McpRequestResources;
  mode: McpMode;
  scopes?: readonly string[] | undefined;
  audience?: "model" | "app";
};

export const listOfferedStaticMcpToolDefinitions = ({
  context,
  mode,
  scopes,
  audience,
  enabledRegistrySlugs,
}: OfferedStaticMcpToolOptions & {
  /** The reachable registries; absent leaves the registry tool un-narrowed. */
  enabledRegistrySlugs?: readonly BusinessRegistrySlug[] | undefined;
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
    ? narrowBusinessRegistryTool(enabledRegistrySlugs, staticDefinitions)
    : staticDefinitions;
};

/**
 * {@link listOfferedStaticMcpToolDefinitions} for a live session: the
 * organization's reachable registries are loaded (settings read and credential
 * decryption) only when the registry tool is among the offered definitions,
 * so a projection that does not offer it never pays for them.
 */
export const loadOfferedStaticMcpToolDefinitions = async (
  options: OfferedStaticMcpToolOptions,
): Promise<readonly McpToolDefinition[]> => {
  const offered = listOfferedStaticMcpToolDefinitions(options);
  if (
    options.mode !== "default" ||
    !offered.some(
      (definition) => definition.name === LOOKUP_BUSINESS_REGISTRY_TOOL_NAME,
    )
  ) {
    return offered;
  }
  return narrowBusinessRegistryTool(
    await resolveOfferedRegistrySlugs(options.context, options.mode),
    offered,
  );
};

/** `undefined` grants every scope (a caller that does not filter by scope). */
export const hasGrantedScope = (
  grantedScopes: readonly string[] | undefined,
  scope: ToolScope,
): boolean =>
  grantedScopes === undefined ||
  (scope === LAW_READ_SCOPE
    ? hasLawReadScope(grantedScopes)
    : grantedScopes.includes(scope));
