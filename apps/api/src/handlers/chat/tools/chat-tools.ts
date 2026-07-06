import { roles } from "@stll/permissions";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/skills";
import {
  APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME,
  createActiveDocxEditTool,
} from "@/api/handlers/chat/tools/active-docx-edit-tool";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createBoeTools } from "@/api/handlers/chat/tools/boe-tools";
import {
  BUSINESS_REGISTRY_LOOKUP_TOOL_NAME,
  createBusinessRegistryTools,
} from "@/api/handlers/chat/tools/business-registry-tools";
import {
  EXPAND_CHAT_HISTORY_TOOL_NAME,
  createChatHistoryTools,
  SEARCH_CHAT_HISTORY_TOOL_NAME,
} from "@/api/handlers/chat/tools/chat-history-tools";
import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import {
  CREATE_DOCUMENT_TOOL_NAME,
  createCreateDocumentTool,
} from "@/api/handlers/chat/tools/create-document-tool";
import {
  buildChatCodeModeTools,
  type ChatCodeModeToolMap,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import {
  createFolioAgentDocTools,
  FIND_TEXT_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import {
  buildChatWriteTools,
  type ChatRegistryWriteToolMap,
} from "@/api/handlers/chat/tools/registry-write-tools";
import { createSkillTools } from "@/api/handlers/chat/tools/skill-tools";
import {
  createTemplateAuthoringTools,
  createTemplateTools,
} from "@/api/handlers/chat/tools/template-tools";
import {
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import {
  createWebSearchTools,
  FETCH_URL_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "@/api/handlers/chat/tools/web-search-tools";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { getDeployAvailableRegistryHandlers } from "@/api/lib/business-registries/dispatch";
import type { ResolvedWebSearchProviders } from "@/api/lib/web-search/select-provider";

export const WEB_SEARCH_NATIVE_TOOL_SLUG = "web-search";

/**
 * Combine deploy/BYOK provider availability with the org's native-tool
 * override. `webSearchProviderAvailable` is resolved per request from
 * the org's stored key (or the platform fallback); callers compute it
 * via `loadWebSearchProvidersForOrg`.
 */
export const isWebSearchAvailable = ({
  webSearchProviderAvailable,
  disabledNativeToolSlugs,
}: {
  webSearchProviderAvailable: boolean;
  disabledNativeToolSlugs?: readonly string[] | undefined;
}): boolean => {
  const webSearchOrgDisabled =
    disabledNativeToolSlugs?.includes(WEB_SEARCH_NATIVE_TOOL_SLUG) ?? false;
  return webSearchProviderAvailable && !webSearchOrgDisabled;
};

type WebResearchToolsRegisteredProps = {
  webSearchEnabled: boolean;
  webSearchProviders: ResolvedWebSearchProviders;
  disabledNativeToolSlugs?: readonly string[] | undefined;
};

/**
 * Single source of truth for "are `web_search` / `fetch_url`
 * registered on this turn". `getChatTools` uses it to decide
 * registration; prompt construction uses it (via the same inputs) to
 * decide whether to instruct the model to use those tools. Deriving
 * both from one predicate is what prevents the prompt from naming a
 * tool the model was never handed.
 */
export const areWebResearchToolsRegistered = ({
  webSearchEnabled,
  webSearchProviders,
  disabledNativeToolSlugs,
}: WebResearchToolsRegisteredProps): boolean =>
  webSearchEnabled &&
  isWebSearchAvailable({
    webSearchProviderAvailable: webSearchProviders.webSearchProvider !== null,
    disabledNativeToolSlugs,
  });

/**
 * Single source of truth for "is `suggest_template_fields` registered
 * on this turn". The tool widens a fill-only role into template
 * authoring, so it maps to `template: ["create"]` rather than the
 * broader `["use"]`. `getChatTools` uses this to decide registration;
 * prompt construction uses it to decide whether the active-template
 * section may steer the model to the tool.
 */
export const areTemplateAuthoringToolsRegistered = (
  memberRole: keyof typeof roles,
): boolean => roles[memberRole].authorize({ template: ["create"] }).success;

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;
type ChatExecutionTools = ChatCodeModeToolMap;
type SkillTools = ReturnType<typeof createSkillTools>;
type BusinessRegistryTools = ReturnType<typeof createBusinessRegistryTools>;
type BoeTools = ReturnType<typeof createBoeTools>;
type InfosoudTools = ReturnType<typeof createInfosoudTools>;
type ActiveDocxEditTools = ReturnType<typeof createActiveDocxEditTools>;
type FolioAgentDocTools = ReturnType<typeof createFolioAgentDocTools>;
type CreateDocumentTools = ReturnType<typeof createCreateDocumentTools>;
type WebSearchTools = ReturnType<typeof createWebSearchTools>;
type ChatHistoryTools = ReturnType<typeof createChatHistoryTools>;
type CurrentSkillEditToolName =
  | "create-current-skill-resource"
  | "update-current-skill-body"
  | "update-current-skill-resource";
type CurrentSkillEditTools = Partial<
  Record<CurrentSkillEditToolName, NonNullable<ChatToolMap[string]>>
>;
type TemplateTools = ReturnType<typeof createTemplateTools>;
type TemplateAuthoringTools = ReturnType<typeof createTemplateAuthoringTools>;
type RegistryWriteTools = ChatRegistryWriteToolMap;

type BuiltInChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  CurrentSkillEditTools &
  BusinessRegistryTools &
  BoeTools &
  InfosoudTools &
  WorkspaceTools &
  ActiveDocxEditTools &
  FolioAgentDocTools &
  CreateDocumentTools &
  WebSearchTools &
  ChatHistoryTools &
  TemplateTools &
  TemplateAuthoringTools &
  RegistryWriteTools;

export type ChatTools = BuiltInChatTools;
type BuiltInChatToolPolicyName =
  | keyof BuiltInChatTools
  | CurrentSkillEditToolName;

type GetChatToolsProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  /**
   * Caller's workspace member role. Gates role-restricted tools so a
   * chat-capable role without the matching grant cannot reach them.
   * Template tools require `template: ["use"]` (the same grant the
   * REST fill route enforces), so a role with `template: []` (e.g.
   * external) sees no template tools.
   */
  memberRole: keyof typeof roles;
  // Required (not optional): the template tools eagerly resolve an AI model for
  // usage metering, which needs the org's BYOK config on deployments without a
  // platform provider. A missing value silently falls back and fails there, so
  // every caller must thread it through explicitly.
  orgAIConfig: OrgAIConfig | null;
  threadId: SafeId<"chatThread">;
  excludedChatHistoryMessageIds?: readonly SafeId<"chatMessage">[] | undefined;
  userId: SafeId<"user">;
  // Use `resolveToolWorkspaceIds` to construct this — that helper is
  // the only path that intersects pinned IDs with the currently
  // accessible set, preventing stale stored pins from widening tool
  // authorization.
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
  refRegistry: ChatRefRegistry;
  /**
   * `true` when the request comes from a surface that has the
   * apply-active-docx-edits client executor mounted (the file
   * overlay or the Template Studio). Other surfaces (standalone
   * chat, global chat) MUST NOT see this tool: the server has no
   * `execute` for it, the client never calls TanStack
   * ChatClient.addToolResult, and the call would hang.
   */
  hasActiveDocxEditClient: boolean;
  /**
   * Per-thread opt-in for the web_search + fetch_url tools. Combined
   * with FEATURE_WEB_SEARCH (deploy gate), the org's
   * disabledNativeToolSlugs ("web-search" disabled), and the presence
   * of a configured WEB_SEARCH_PROVIDER — all four must hold for the
   * tools to be registered on a turn.
   */
  webSearchEnabled: boolean;
  /**
   * Web-search + url-fetch providers resolved for this org (BYOK key
   * first, platform env key as fallback). Resolve via
   * `loadWebSearchProvidersForOrg`. A null `webSearchProvider` means
   * the feature is unavailable for the org and the tools are skipped.
   */
  webSearchProviders: ResolvedWebSearchProviders;
  externalTools?: ChatToolMap | undefined;
  /**
   * Native tool slugs (e.g. "ares") the org has disabled in chat.
   * Validation tool sets ignore this — past tool messages must still
   * pass schema validation — so callers should only narrow on the
   * live execution path.
   */
  disabledNativeToolSlugs?: readonly string[] | undefined;
  skillMetadata?: readonly SkillMetadata[] | undefined;
  activeSkillContext?: ActiveChatSkillContext | null | undefined;
  recordAuditEvent?: AuditRecorder | undefined;
  /**
   * Status of every accessible (non-deleting) workspace, keyed by id. Threaded
   * into the projected write tools' MCP context so their `ensureActiveWorkspace`
   * gate keeps archived matters read-only, matching MCP/REST writes.
   * `activeWorkspaceIds` includes archived workspaces, so a missing status must
   * NOT default to "active" on the write path; callers supply real statuses
   * from `accessibleWorkspaces`.
   */
  workspaceStatusById?:
    | ReadonlyMap<string, AccessibleWorkspace["status"]>
    | undefined;
};

const createActiveDocxEditTools = () => ({
  [APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]: createActiveDocxEditTool(),
});

const createCreateDocumentTools = () => ({
  [CREATE_DOCUMENT_TOOL_NAME]: createCreateDocumentTool(),
});

const BUILT_IN_CHAT_TOOL_POLICY_KINDS = {
  [APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  "ask-user": CHAT_TOOL_POLICY_KIND.internal,
  boe_find_related_laws: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_get_law: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_get_law_block: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_get_law_structure: CHAT_TOOL_POLICY_KIND.publicOfficial,
  boe_search_legislation: CHAT_TOOL_POLICY_KIND.publicOfficial,
  borme_get_summary: CHAT_TOOL_POLICY_KIND.publicOfficial,
  [BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.publicOfficial,
  "create-document": CHAT_TOOL_POLICY_KIND.internal,
  "create-current-skill-resource": CHAT_TOOL_POLICY_KIND.mutation,
  describe_template: CHAT_TOOL_POLICY_KIND.internal,
  // Code-mode tool discovery: read-only, gated by the same authorization that
  // let the request reach chat at all; runs immediately without per-call
  // approval, alongside the sandbox runner it feeds.
  discover_tools: CHAT_TOOL_POLICY_KIND.internal,
  // The sandbox code runner (replaces run-stella-query). Executes only the
  // ref-mediated read projections in the hardened sandbox, so it is internal
  // and executes without per-call approval.
  execute_typescript: CHAT_TOOL_POLICY_KIND.internal,
  [EXPAND_CHAT_HISTORY_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  // Per-thread `webSearchEnabled` already gates the tools; an
  // additional per-call approval would double-gate and block
  // streaming until the user clicks Allow. Classify alongside the
  // official-registry lookups so the model executes immediately
  // once the toggle is on.
  [FETCH_URL_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.publicOfficial,
  [FIND_TEXT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  // A write: served by the hand-written template chat tool (not the registry
  // write projection), but still gated on approval like every other write.
  fill_template: CHAT_TOOL_POLICY_KIND.mutation,
  infosoud_lookup_case: CHAT_TOOL_POLICY_KIND.publicOfficial,
  list_templates: CHAT_TOOL_POLICY_KIND.internal,
  "load-skill": CHAT_TOOL_POLICY_KIND.internal,
  [READ_DOCUMENT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  "read-skill-resource": CHAT_TOOL_POLICY_KIND.internal,
  [SEARCH_CHAT_HISTORY_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  suggest_template_fields: CHAT_TOOL_POLICY_KIND.internal,
  "update-current-skill-body": CHAT_TOOL_POLICY_KIND.mutation,
  "update-current-skill-resource": CHAT_TOOL_POLICY_KIND.mutation,
  "update-entity-fields": CHAT_TOOL_POLICY_KIND.mutation,
  [WEB_SEARCH_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.publicOfficial,
  // Registry write projections: every projected `access: "write"` tool is a
  // per-call mutation, so it maps to `mutation` (needsApproval). The
  // `Record<BuiltInChatToolPolicyName, ...>` satisfies below forces a policy
  // entry for each projected write name, so a newly projected write cannot land
  // without an approval classification.
  delete_clause: CHAT_TOOL_POLICY_KIND.mutation,
  delete_contact: CHAT_TOOL_POLICY_KIND.mutation,
  delete_document: CHAT_TOOL_POLICY_KIND.mutation,
  delete_matter: CHAT_TOOL_POLICY_KIND.mutation,
  delete_time_entry: CHAT_TOOL_POLICY_KIND.mutation,
  link_matter_contact: CHAT_TOOL_POLICY_KIND.mutation,
  manage_organization: CHAT_TOOL_POLICY_KIND.mutation,
  run_playbook: CHAT_TOOL_POLICY_KIND.mutation,
  save_clause: CHAT_TOOL_POLICY_KIND.mutation,
  save_contact: CHAT_TOOL_POLICY_KIND.mutation,
  save_document: CHAT_TOOL_POLICY_KIND.mutation,
  save_matter: CHAT_TOOL_POLICY_KIND.mutation,
  save_task: CHAT_TOOL_POLICY_KIND.mutation,
  save_template: CHAT_TOOL_POLICY_KIND.mutation,
  save_time_entry: CHAT_TOOL_POLICY_KIND.mutation,
  set_field_value: CHAT_TOOL_POLICY_KIND.mutation,
  set_practice_jurisdictions: CHAT_TOOL_POLICY_KIND.mutation,
} as const satisfies Record<
  BuiltInChatToolPolicyName,
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND]
>;

export const getChatTools = ({
  safeDb,
  scopedDb,
  organizationId,
  memberRole,
  orgAIConfig,
  threadId,
  excludedChatHistoryMessageIds,
  userId,
  toolWorkspaceIds,
  refRegistry,
  hasActiveDocxEditClient,
  webSearchEnabled,
  webSearchProviders,
  externalTools = {},
  disabledNativeToolSlugs,
  skillMetadata,
  activeSkillContext,
  recordAuditEvent,
  workspaceStatusById,
}: GetChatToolsProps): ChatToolMap => {
  const orgTools = createOrgTools({
    accessibleWorkspaceIds: toolWorkspaceIds,
    organizationId,
    scopedDb,
  });
  const webResearchAvailable = areWebResearchToolsRegistered({
    webSearchEnabled,
    webSearchProviders,
    disabledNativeToolSlugs,
  });
  // Chat's code-execution surface, projected from the MCP registry through the
  // hardened sandbox: the single `execute_typescript` runner plus its
  // `discover_tools` companion. Replaces the hand-written run-stella-query /
  // describe-stella-api pair; the read functions it exposes as `external_*`
  // bindings are ref-mediated, so no tenant UUID reaches the model.
  const executionTools = buildChatCodeModeTools({
    memberRole,
    organizationId,
    recordAuditEvent,
    refRegistry,
    safeDb,
    scopedDb,
    toolWorkspaceIds,
    userId,
  });
  const skillTools = createSkillTools({
    activeSkillContext,
    organizationId,
    recordAuditEvent,
    safeDb,
    skills: skillMetadata ?? getChatSkillMetadata(),
    userId,
  });
  // Unified business-registry tool: register once with a dynamic
  // `jurisdiction` enum derived from the per-adapter native-tool
  // enablement. Shipped adapters are filtered by deployment config
  // first (e.g. EDGAR requires EDGAR_USER_AGENT), then by org-level
  // native-tool enablement. Empty list means the tool isn't
  // registered at all (no dead picker for the model).
  const businessRegistryJurisdictions = getDeployAvailableRegistryHandlers()
    .filter(
      (handler) =>
        !(disabledNativeToolSlugs?.includes(handler.nativeToolSlug) ?? false),
    )
    .map((handler) => handler.country);
  const businessRegistryTools = createBusinessRegistryTools({
    enabledJurisdictions: businessRegistryJurisdictions,
  });
  const boeDisabled = disabledNativeToolSlugs?.includes("boe") ?? false;
  const boeTools = boeDisabled ? {} : createBoeTools();
  const infosoudDisabled =
    disabledNativeToolSlugs?.includes("infosoud") ?? false;
  const infosoudTools = infosoudDisabled ? {} : createInfosoudTools();
  const { webSearchProvider, urlFetcher } = webSearchProviders;
  // The `webSearchProvider !== null` re-check narrows the type for
  // createWebSearchTools; it is implied by `webResearchAvailable`.
  const webSearchTools =
    webResearchAvailable && webSearchProvider !== null
      ? createWebSearchTools({ webSearchProvider, urlFetcher })
      : {};
  const activeDocxEditTools = hasActiveDocxEditClient
    ? createActiveDocxEditTools()
    : {};
  // Same precondition as `apply-active-docx-edits`: a live editor surface
  // with a client tool handler mounted. Other surfaces have no
  // `FolioAgentBridge` to execute these against, so the tools must stay
  // unregistered there rather than hang waiting for a client result.
  const folioAgentDocTools = hasActiveDocxEditClient
    ? createFolioAgentDocTools()
    : {};
  const historyTools = createChatHistoryTools({
    excludedMessageIds: excludedChatHistoryMessageIds,
    safeDb,
    threadId,
  });
  const externalChatTools = applyChatToolPolicies({
    defaultPolicyKind: CHAT_TOOL_POLICY_KIND.external,
    tools: externalTools,
  });

  // Workspace tools are always registered. When the chat is not
  // pinned to any specific matter, `toolWorkspaceIds` is the user's
  // full accessible set; the matter is resolved per-call by the
  // chat client (sticky thread-local matter or matter-pick UI).
  const workspaceTools = createWorkspaceTools({
    allowedWorkspaceIds: toolWorkspaceIds,
    scopedDb,
  });

  // Template library tools: list, describe, and fill templates. Their
  // execute fns rely on org RLS alone, so gate registration on the same
  // `template: ["use"]` grant the REST fill route enforces; a
  // chat-capable role without it sees no template tools.
  const canUseTemplates = roles[memberRole].authorize({
    template: ["use"],
  }).success;
  const templateTools = canUseTemplates
    ? createTemplateTools({
        scopedDb,
        safeDb,
        organizationId,
        userId,
        orgAIConfig,
        recordAuditEvent,
      })
    : {};

  // `suggest_template_fields` proposes turning literals into {{field}}
  // placeholders, i.e. it assists template authoring, not filling. Gate it
  // behind `template: ["create"]` so a fill-only role (e.g. intern, which has
  // `use` but not `create`) cannot reach authoring assistance.
  const templateAuthoringTools = areTemplateAuthoringToolsRegistered(memberRole)
    ? createTemplateAuthoringTools({
        safeDb,
        organizationId,
        userId,
        orgAIConfig,
      })
    : {};

  // create-document is client-executed (no server `execute`) — the
  // chat client picks the destination matter and posts the result
  // via TanStack ChatClient.addToolResult. It is always registered so the
  // model can see and call it from any chat surface.
  const createDocumentTools = createCreateDocumentTools();

  // Registry write projections: per-call mutation tools (save/delete/etc.),
  // each behind approval. Gated on a non-empty workspace set exactly like the
  // hand-written workspace mutation tool (`createWorkspaceTools`), so
  // anonymous/public surfaces with no accessible workspace never receive write
  // tools. Real per-workspace statuses are threaded through so the handlers'
  // `ensureActiveWorkspace` gate keeps archived matters read-only.
  const registryWriteTools =
    toolWorkspaceIds.length === 0
      ? {}
      : buildChatWriteTools({
          memberRole,
          organizationId,
          recordAuditEvent,
          refRegistry,
          safeDb,
          scopedDb,
          toolWorkspaceIds,
          userId,
          workspaceStatusById,
        });

  return applyChatToolPolicies({
    policyKinds: BUILT_IN_CHAT_TOOL_POLICY_KINDS,
    tools: {
      ...orgTools,
      ...executionTools,
      ...skillTools,
      ...businessRegistryTools,
      ...boeTools,
      ...infosoudTools,
      ...workspaceTools,
      ...templateTools,
      ...templateAuthoringTools,
      ...historyTools,
      ...createDocumentTools,
      ...activeDocxEditTools,
      ...folioAgentDocTools,
      ...webSearchTools,
      ...registryWriteTools,
      ...externalChatTools,
    },
  });
};
