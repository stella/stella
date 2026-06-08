import type { ToolSet } from "ai";

import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
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
import {
  CREATE_DOCUMENT_TOOL_NAME,
  createCreateDocumentTool,
} from "@/api/handlers/chat/tools/create-document-tool";
import { createChatExecutionTools } from "@/api/handlers/chat/tools/execute/chat-execution-tools";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import { createSkillTools } from "@/api/handlers/chat/tools/skill-tools";
import { createTemplateTools } from "@/api/handlers/chat/tools/template-tools";
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
import type { SafeId } from "@/api/lib/branded-types";
import { getDeployAvailableRegistryHandlers } from "@/api/lib/business-registries/dispatch";
import { isWebSearchDeployAvailable } from "@/api/lib/web-search/select-provider";

export const WEB_SEARCH_NATIVE_TOOL_SLUG = "web-search";

export const isWebSearchAvailable = (
  disabledNativeToolSlugs?: readonly string[],
): boolean => {
  const webSearchOrgDisabled =
    disabledNativeToolSlugs?.includes(WEB_SEARCH_NATIVE_TOOL_SLUG) ?? false;
  return isWebSearchDeployAvailable() && !webSearchOrgDisabled;
};

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;
type ChatExecutionTools = ReturnType<typeof createChatExecutionTools>;
type SkillTools = ReturnType<typeof createSkillTools>;
type BusinessRegistryTools = ReturnType<typeof createBusinessRegistryTools>;
type BoeTools = ReturnType<typeof createBoeTools>;
type InfosoudTools = ReturnType<typeof createInfosoudTools>;
type ActiveDocxEditTools = ReturnType<typeof createActiveDocxEditTools>;
type CreateDocumentTools = ReturnType<typeof createCreateDocumentTools>;
type WebSearchTools = ReturnType<typeof createWebSearchTools>;
type ChatHistoryTools = ReturnType<typeof createChatHistoryTools>;
type TemplateTools = ReturnType<typeof createTemplateTools>;

type BuiltInChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  BusinessRegistryTools &
  BoeTools &
  InfosoudTools &
  WorkspaceTools &
  ActiveDocxEditTools &
  CreateDocumentTools &
  WebSearchTools &
  ChatHistoryTools &
  TemplateTools;

export type ChatTools = BuiltInChatTools;

type GetChatToolsProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
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
   * overlay). Other surfaces (standalone chat, global chat) MUST
   * NOT see this tool: the server has no `execute` for it, the
   * client never calls `addToolOutput`, and the call would hang.
   */
  hasActiveFileChat: boolean;
  /**
   * Per-thread opt-in for the web_search + fetch_url tools. Combined
   * with FEATURE_WEB_SEARCH (deploy gate), the org's
   * disabledNativeToolSlugs ("web-search" disabled), and the presence
   * of a configured WEB_SEARCH_PROVIDER — all four must hold for the
   * tools to be registered on a turn.
   */
  webSearchEnabled: boolean;
  externalTools?: ToolSet | undefined;
  /**
   * Native tool slugs (e.g. "ares") the org has disabled in chat.
   * Validation tool sets ignore this — past tool messages must still
   * pass schema validation — so callers should only narrow on the
   * live execution path.
   */
  disabledNativeToolSlugs?: readonly string[] | undefined;
  skillMetadata?: readonly SkillMetadata[] | undefined;
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
  "describe-stella-api": CHAT_TOOL_POLICY_KIND.internal,
  [EXPAND_CHAT_HISTORY_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  // Per-thread `webSearchEnabled` already gates the tools; an
  // additional per-call approval would double-gate and block
  // streaming until the user clicks Allow. Classify alongside the
  // official-registry lookups so the model executes immediately
  // once the toggle is on.
  [FETCH_URL_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.publicOfficial,
  infosoud_lookup_case: CHAT_TOOL_POLICY_KIND.publicOfficial,
  list_templates: CHAT_TOOL_POLICY_KIND.internal,
  "load-skill": CHAT_TOOL_POLICY_KIND.internal,
  "read-skill-resource": CHAT_TOOL_POLICY_KIND.internal,
  "run-stella-query": CHAT_TOOL_POLICY_KIND.internal,
  [SEARCH_CHAT_HISTORY_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  "update-entity-fields": CHAT_TOOL_POLICY_KIND.mutation,
  [WEB_SEARCH_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.publicOfficial,
} as const satisfies Record<
  keyof BuiltInChatTools,
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND]
>;

export const getChatTools = ({
  safeDb,
  scopedDb,
  organizationId,
  threadId,
  excludedChatHistoryMessageIds,
  userId,
  toolWorkspaceIds,
  refRegistry,
  hasActiveFileChat,
  webSearchEnabled,
  externalTools = {},
  disabledNativeToolSlugs,
  skillMetadata,
}: GetChatToolsProps): ToolSet => {
  const orgTools = createOrgTools({
    accessibleWorkspaceIds: toolWorkspaceIds,
    organizationId,
    scopedDb,
  });
  const executionTools = createChatExecutionTools({
    accessibleWorkspaceIds: toolWorkspaceIds,
    organizationId,
    refRegistry,
    safeDb,
    userId,
  });
  const skillTools = createSkillTools({
    organizationId,
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
  const webSearchTools =
    webSearchEnabled && isWebSearchAvailable(disabledNativeToolSlugs)
      ? createWebSearchTools()
      : {};
  const activeDocxEditTools = hasActiveFileChat
    ? createActiveDocxEditTools()
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

  // Template library tools (list templates; describe/fill to follow).
  const templateTools = createTemplateTools({ scopedDb });

  // create-document is client-executed (no server `execute`) — the
  // chat client picks the destination matter and posts the result
  // via the AI SDK's addToolOutput. It is always registered so the
  // model can see and call it from any chat surface.
  const createDocumentTools = createCreateDocumentTools();

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
      ...historyTools,
      ...createDocumentTools,
      ...activeDocxEditTools,
      ...webSearchTools,
      ...externalChatTools,
    },
  });
};
