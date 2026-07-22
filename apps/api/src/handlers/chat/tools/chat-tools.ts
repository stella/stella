import { roles } from "@stll/permissions";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  CHAT_EDIT_APPLY_MODE,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  type ChatEditApplyMode,
  type DocxEditRepresentation,
} from "@/api/handlers/chat/chat-schema";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/skills";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
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
import type {
  ChatToolMap,
  ChatUIToolsFor,
} from "@/api/handlers/chat/tools/chat-tool-types";
import {
  CREATE_DOCUMENT_TOOL_NAME,
  createCreateDocumentTool,
} from "@/api/handlers/chat/tools/create-document-tool";
import {
  CREATE_WORKSPACE_DOCUMENT_TOOL_NAME,
  createCreateWorkspaceDocumentTools,
} from "@/api/handlers/chat/tools/create-workspace-document-tools";
import {
  createEditWorkspaceDocumentTools,
  EDIT_WORKSPACE_DOCUMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/edit-workspace-document-tools";
import {
  buildChatCodeModeTools,
  type ChatCodeModeToolMap,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import {
  ADD_COMMENT_TOOL_NAME,
  createFolioAgentDocTools,
  FIND_TEXT_TOOL_NAME,
  READ_CHANGES_TOOL_NAME,
  READ_COMMENTS_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
  REPLY_COMMENT_TOOL_NAME,
  RESOLVE_COMMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import {
  buildChatWriteTools,
  type ChatRegistryWriteToolMap,
} from "@/api/handlers/chat/tools/registry-write-tools";
import { createSkillTools } from "@/api/handlers/chat/tools/skill-tools";
import {
  createSpawnSubagentsTool,
  SPAWN_SUBAGENTS_TOOL_NAME,
  SUBAGENT_DELEGATION_DEPTH_CAP,
} from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { projectToolMapForSubagent } from "@/api/handlers/chat/tools/subagent-tools";
import {
  createTemplateAuthoringTools,
  createTemplateTools,
} from "@/api/handlers/chat/tools/template-tools";
import {
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import {
  COMPARE_VERSIONS_TOOL_NAME,
  createVersionCompareTools,
} from "@/api/handlers/chat/tools/version-compare-tools";
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

type SubagentToolsRegisteredProps = {
  delegationDepth?: number | undefined;
};

/**
 * Single source of truth for "is `spawn_subagents` registered on this
 * turn". `getChatTools` uses the same `delegationDepth` comparison to
 * decide registration; prompt construction uses this predicate to
 * decide whether the delegation section may steer the model to the
 * tool.
 */
export const areSubagentToolsRegistered = ({
  delegationDepth,
}: SubagentToolsRegisteredProps): boolean =>
  (delegationDepth ?? 0) < SUBAGENT_DELEGATION_DEPTH_CAP;

type ResolveRegisteredDocxEditModeOptions = {
  activeFile: GetChatToolsProps["activeFile"];
  editApplyMode: ChatEditApplyMode;
  hasActiveDocxEditClient: boolean;
  memberRole: keyof typeof roles;
  recordAuditEventAvailable: boolean;
  requestWorkspaceId: SafeId<"workspace"> | null;
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
  workspaceStatusById:
    | ReadonlyMap<string, AccessibleWorkspace["status"]>
    | undefined;
};

/**
 * Single source of truth for which mutually exclusive DOCX edit tool is
 * registered on a turn. Prompt construction calls the same predicate, so it
 * cannot direct the model to a tool that authorization or active-file state
 * removed from the tool map.
 */
export const resolveRegisteredDocxEditMode = ({
  activeFile,
  editApplyMode,
  hasActiveDocxEditClient,
  memberRole,
  recordAuditEventAvailable,
  requestWorkspaceId,
  toolWorkspaceIds,
  workspaceStatusById,
}: ResolveRegisteredDocxEditModeOptions): ChatEditApplyMode | null => {
  if (editApplyMode === CHAT_EDIT_APPLY_MODE.manual) {
    return hasActiveDocxEditClient ? CHAT_EDIT_APPLY_MODE.manual : null;
  }

  if (
    activeFile?.supportsDocxEdits !== true ||
    activeFile.fileFieldId === undefined ||
    requestWorkspaceId === null ||
    !recordAuditEventAvailable ||
    !toolWorkspaceIds.includes(requestWorkspaceId) ||
    workspaceStatusById?.get(requestWorkspaceId) !== "active"
  ) {
    return null;
  }

  const canEditWorkspaceDocument = roles[memberRole].authorize({
    entity: ["update"],
  }).success;
  return canEditWorkspaceDocument ? CHAT_EDIT_APPLY_MODE.auto : null;
};

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
type CreateWorkspaceDocumentTools = ReturnType<
  typeof createCreateWorkspaceDocumentTools
>;
type EditWorkspaceDocumentTools = ReturnType<
  typeof createEditWorkspaceDocumentTools
>;
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
type VersionCompareTools = ReturnType<typeof createVersionCompareTools>;
type RegistryWriteTools = ChatRegistryWriteToolMap;
type SubagentTools = ReturnType<typeof createSpawnSubagentsTool>;

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
  CreateWorkspaceDocumentTools &
  EditWorkspaceDocumentTools &
  WebSearchTools &
  ChatHistoryTools &
  TemplateTools &
  TemplateAuthoringTools &
  VersionCompareTools &
  RegistryWriteTools &
  SubagentTools;

export type ChatTools = BuiltInChatTools;

export type ChatBuiltinApprovalToolName = Exclude<
  keyof ChatUIToolsFor<BuiltInChatTools>,
  "ask-user" | "create-document"
>;

type BuiltInChatToolPolicyName =
  | keyof BuiltInChatTools
  | CurrentSkillEditToolName;

type GetChatToolsProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  pinServerValidatedWorkspaceId: (workspaceId: SafeId<"workspace">) => boolean;
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
  /**
   * The request's scope workspace (or `null` for global chat), for
   * subagent usage metering. Distinct from `toolWorkspaceIds`, which
   * is the (possibly pinned) set of workspaces tools may read/write.
   */
  requestWorkspaceId: SafeId<"workspace"> | null;
  threadId: SafeId<"chatThread">;
  excludedChatHistoryMessageIds?: readonly SafeId<"chatMessage">[] | undefined;
  userId: SafeId<"user">;
  // Use `resolveToolWorkspaceIds` to construct this — that helper is
  // the only path that intersects pinned IDs with the currently
  // accessible set, preventing stale stored pins from widening tool
  // authorization.
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
  activeFile?:
    | {
        entityId: SafeId<"entity">;
        currentVersionId?: SafeId<"entityVersion"> | undefined;
        fileFieldId?: SafeId<"field"> | undefined;
        supportsDocxEdits?: boolean | undefined;
      }
    | undefined;
  refRegistry: ChatRefRegistry;
  /**
   * The turn's anonymization boundary. Threaded into
   * `createSpawnSubagentsTool` so each subagent's own model calls cross
   * the same anonymize/deanonymize boundary as the parent turn; the
   * recursive `buildSubagentToolset` call re-spreads `props`, so nested
   * levels inherit it automatically.
   */
  thirdPartyBoundary: ChatThirdPartyBoundary;
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
   * `true` only for the file overlay: `activeFile.supportsDocxEdits`,
   * with no Template Studio fallback. Narrower than
   * `hasActiveDocxEditClient` on purpose — only `file-chat-overlay.tsx`
   * mounts the auto-run watcher
   * (`isUnresolvedFolioAgentDocToolCallPart` /
   * `runFolioAgentDocToolCall`) that resolves the folio-agents
   * `read_document` / `find_text` tools via `addToolResult`.
   * Template Studio has no such watcher, so registering these tools
   * there would hang the turn waiting for a client result that never
   * arrives. Gates `createFolioAgentDocTools()` registration below;
   * `apply-active-docx-edits` stays on the combined
   * `hasActiveDocxEditClient` flag since Template Studio does handle
   * that one.
   */
  hasActiveDocxFileClient: boolean;
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
  /**
   * Current delegation depth; 0 at top level. Subagent toolsets are
   * built by re-invoking `getChatTools` with `depth + 1` (see
   * `createSpawnSubagentsTool`'s `buildSubagentToolset`), which is how
   * `spawn_subagents` stops being registered past
   * `SUBAGENT_DELEGATION_DEPTH_CAP`.
   */
  delegationDepth?: number | undefined;
  /**
   * Which DOCX-edit review mode this turn uses; defaults to
   * `DEFAULT_CHAT_EDIT_APPLY_MODE` ("auto": AI edits auto-apply as
   * tracked changes by default). Gates `apply-active-docx-edits` and
   * `edit_workspace_document` into a mutually exclusive pair -- exactly
   * one of the two is ever registered for a given turn, never both.
   * Neither registers when `edit_workspace_document`'s own preconditions
   * (an entity-backed active DOCX file, `entity:update`, active matter)
   * fail to hold in "auto" mode -- e.g. Template Studio, which has no
   * entity-backed `activeFile`, must explicitly pass "manual" to keep
   * its DOCX-edit tool.
   */
  editApplyMode?: ChatEditApplyMode | undefined;
  /**
   * Redline representation `edit_workspace_document` (the `auto` mode)
   * applies operations with; defaults to `DEFAULT_DOCX_EDIT_REPRESENTATION`.
   * Ignored in `manual` mode.
   */
  docxEditRepresentation?: DocxEditRepresentation | undefined;
  /**
   * Validation-only widening for continuation messages. A pending DOCX tool
   * call was issued under the mode selected on the previous request, so its
   * call/result must remain schema-valid even if the user changed the composer
   * mode before approving it. Live streaming callers must leave this false so
   * the model still receives exactly one DOCX edit tool.
   */
  includeAllDocxEditToolsForValidation?: boolean | undefined;
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
  boe_search_legislation: CHAT_TOOL_POLICY_KIND.external,
  borme_get_summary: CHAT_TOOL_POLICY_KIND.publicOfficial,
  [BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.publicOfficial,
  // Server-executed, read-only version diff: resolves version ids to DOCX
  // buffers under the caller's authorized workspaces and returns text, so it
  // runs immediately without per-call approval.
  [COMPARE_VERSIONS_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  "create-document": CHAT_TOOL_POLICY_KIND.internal,
  "create-current-skill-resource": CHAT_TOOL_POLICY_KIND.mutation,
  // Renders Markdown into a Stella-styled DOCX and creates a new entity in
  // the active matter (`create-from-buffer.ts`'s S3 + DB write path): a
  // mutation, gated on per-call approval like every other write.
  [CREATE_WORKSPACE_DOCUMENT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.mutation,
  describe_template: CHAT_TOOL_POLICY_KIND.internal,
  // Headless (auto) DOCX edit: writes a new entity version with no per-
  // suggestion human review step (unlike apply-active-docx-edits, which
  // only queues suggestions), so it needs per-call approval like every
  // other write.
  [EDIT_WORKSPACE_DOCUMENT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.mutation,
  // Code-mode tool discovery: read-only, gated by the same authorization that
  // let the request reach chat at all; runs immediately without per-call
  // approval, alongside the sandbox runner it feeds.
  discover_tools: CHAT_TOOL_POLICY_KIND.internal,
  // The sandbox code runner (replaces run-stella-query). Executes only the
  // ref-mediated read projections in the hardened sandbox, so it is internal
  // and executes without per-call approval.
  execute_typescript: CHAT_TOOL_POLICY_KIND.internal,
  [EXPAND_CHAT_HISTORY_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  // Per-thread `webSearchEnabled` controls availability. Individual calls use
  // the external-service policy because their inputs can contain free text.
  [FETCH_URL_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.external,
  [FIND_TEXT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  // folio-agents live-editor read tools: read-only, auto-run against the file
  // overlay's editor bridge (same class as read_document / find_text).
  [READ_CHANGES_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  [READ_COMMENTS_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  // folio-agents comment mutations: each writes a tracked comment / reply /
  // resolution, so each is a per-call mutation behind approval, resolved
  // client-side through the same flow as apply-active-docx-edits.
  [ADD_COMMENT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.mutation,
  [REPLY_COMMENT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.mutation,
  [RESOLVE_COMMENT_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.mutation,
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
  [WEB_SEARCH_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.external,
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
  // `spawn_subagents` itself is approval-gated at the top level. A subagent's
  // own writes are NOT executed under that grant: `projectToolMapForSubagent`
  // replaces every approval-requiring tool with a non-executing proposal that
  // is surfaced back to the top-level loop for per-write user approval
  // (buffered approval).
  [SPAWN_SUBAGENTS_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.mutation,
} as const satisfies Record<
  BuiltInChatToolPolicyName,
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND]
>;

export const getChatTools = (props: GetChatToolsProps): ChatToolMap => {
  const {
    safeDb,
    scopedDb,
    pinServerValidatedWorkspaceId,
    organizationId,
    memberRole,
    orgAIConfig,
    requestWorkspaceId,
    threadId,
    excludedChatHistoryMessageIds,
    userId,
    toolWorkspaceIds,
    activeFile,
    refRegistry,
    thirdPartyBoundary,
    hasActiveDocxEditClient,
    hasActiveDocxFileClient,
    webSearchEnabled,
    webSearchProviders,
    externalTools = {},
    disabledNativeToolSlugs,
    skillMetadata,
    activeSkillContext,
    recordAuditEvent,
    workspaceStatusById,
    editApplyMode = DEFAULT_CHAT_EDIT_APPLY_MODE,
    docxEditRepresentation = DEFAULT_DOCX_EDIT_REPRESENTATION,
    includeAllDocxEditToolsForValidation = false,
  } = props;

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
  // `editApplyMode === "auto"` also requires the client-executed manual
  // tool to stay OFF: the two review modes are mutually exclusive tool
  // surfaces (see `editApplyMode`'s doc comment), never both registered
  // for the same turn.
  const registeredDocxEditMode = resolveRegisteredDocxEditMode({
    activeFile,
    editApplyMode,
    hasActiveDocxEditClient,
    memberRole,
    recordAuditEventAvailable: recordAuditEvent !== undefined,
    requestWorkspaceId,
    toolWorkspaceIds,
    workspaceStatusById,
  });
  const activeDocxEditTools =
    registeredDocxEditMode === CHAT_EDIT_APPLY_MODE.manual ||
    (includeAllDocxEditToolsForValidation && hasActiveDocxEditClient)
      ? createActiveDocxEditTools()
      : {};
  const automaticDocxEditAvailableForValidation =
    includeAllDocxEditToolsForValidation &&
    resolveRegisteredDocxEditMode({
      activeFile,
      editApplyMode: CHAT_EDIT_APPLY_MODE.auto,
      hasActiveDocxEditClient,
      memberRole,
      recordAuditEventAvailable: recordAuditEvent !== undefined,
      requestWorkspaceId,
      toolWorkspaceIds,
      workspaceStatusById,
    }) === CHAT_EDIT_APPLY_MODE.auto;
  // Narrower than `apply-active-docx-edits` above: only the file
  // overlay mounts the auto-run watcher that resolves these via
  // `addToolResult` (see `hasActiveDocxFileClient` doc comment).
  // Template Studio has no such watcher, so the tools must stay
  // unregistered there rather than hang waiting for a client result.
  const folioAgentDocTools = hasActiveDocxFileClient
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

  // create_workspace_document is server-executed (immediate, no client
  // matter-pick round trip like `create-document`), so its destination
  // workspace must come from server-validated context rather than model
  // input or a client-side picker. `requestWorkspaceId` is that context: the
  // request's single pinned/active matter. Gated on it being set (chat
  // surfaces with no active matter, e.g. global chat, never see this tool)
  // and re-checked against `toolWorkspaceIds` as defense in depth. Also
  // requires `recordAuditEvent` (mirrors `createSkillTools`'s
  // `recordAuditEvent !== undefined` gate for its own mutation tools) since
  // `createEntityFromBuffer` always writes an audit event.
  //
  // Because this tool calls `createEntityFromBuffer` directly instead of
  // going through the MCP `save_document` / REST `create-from-legal-source`
  // dispatch, it does not inherit either of those paths' authorization
  // checks — so both are mirrored here explicitly:
  //   - `entity: ["create"]` permission, the same grant `save_document`'s
  //     create branch checks in `document-tools.ts`
  //     (`roles[context.memberRole].authorize({ entity: ["create"] })`) and
  //     `create-from-legal-source`'s `permissions` config enforces. Without
  //     it, a chat-capable-but-entity-create-less role (e.g. `intern`, which
  //     has `chat` but `entity: []`) could create documents through chat
  //     alone.
  //   - Active (non-archived) matter status, read from the same
  //     `workspaceStatusById` map the registry write tools thread into
  //     `buildMcpContextFromChat` for their own `ensureActiveWorkspace` gate
  //     (`toolWorkspaceIds` includes archived matters, so that alone is not
  //     enough). Without it, an archived matter would stay writable through
  //     this tool alone.
  // KNOWN LIMITATION: creates at the matter root every time — there is no
  // folder/parent targeting yet.
  const canCreateWorkspaceDocument = roles[memberRole].authorize({
    entity: ["create"],
  }).success;
  const createWorkspaceDocumentTools =
    requestWorkspaceId !== null &&
    recordAuditEvent !== undefined &&
    toolWorkspaceIds.includes(requestWorkspaceId) &&
    canCreateWorkspaceDocument &&
    workspaceStatusById?.get(requestWorkspaceId) === "active"
      ? createCreateWorkspaceDocumentTools({
          scopedDb,
          organizationId,
          userId,
          workspaceId: requestWorkspaceId,
          recordAuditEvent,
          refRegistry,
        })
      : {};

  // edit_workspace_document is the headless (`auto`) counterpart to
  // `apply-active-docx-edits`: it writes a new entity version directly
  // instead of queuing suggestions into the browser review panel, so it
  // needs its own explicit authorization mirror rather than inheriting one
  // from the manual tool (which has none of its own -- it never writes).
  // Registered ONLY when every one of these holds:
  //   - `editApplyMode === "auto"`: the session opted into headless apply
  //     (see `editApplyMode`'s doc comment on `GetChatToolsProps`); this is
  //     what makes the tool mutually exclusive with the manual one above.
  //   - An editable active DOCX file is present
  //     (`activeFile.supportsDocxEdits === true`), the same precondition
  //     `apply-active-docx-edits` and `compare_versions` use.
  //   - `entity: ["update"]` permission -- this tool overwrites the active
  //     document's content, the same grant `docx-suggestions/create.ts`,
  //     `resolve.ts`, and `upload-version.ts` require for DOCX edits.
  //     `create_workspace_document` above checks `entity: ["create"]`
  //     instead because it creates a new document; this tool edits an
  //     existing one, so it checks the "update" action, not "create".
  //   - Active (non-archived) matter status, from the same
  //     `workspaceStatusById` map `create_workspace_document` reads, so an
  //     archived matter stays read-only through this tool too.
  //   - `recordAuditEvent` present, since `createEntityVersionFromBuffer`
  //     always writes an audit event.
  const editWorkspaceDocumentTools =
    (registeredDocxEditMode === CHAT_EDIT_APPLY_MODE.auto ||
      automaticDocxEditAvailableForValidation) &&
    activeFile !== undefined &&
    activeFile.currentVersionId !== undefined &&
    activeFile.fileFieldId !== undefined &&
    requestWorkspaceId !== null &&
    recordAuditEvent !== undefined
      ? createEditWorkspaceDocumentTools({
          safeDb,
          organizationId,
          userId,
          workspaceId: requestWorkspaceId,
          entityId: activeFile.entityId,
          expectedCurrentVersionId: activeFile.currentVersionId,
          fileFieldId: activeFile.fileFieldId,
          recordAuditEvent,
          docxEditRepresentation,
        })
      : {};

  // Registry write projections: per-call mutation tools (save/delete/etc.),
  // each behind approval. Gated on a non-empty workspace set exactly like the
  // hand-written workspace mutation tool (`createWorkspaceTools`), so
  // anonymous/public surfaces with no accessible workspace never receive write
  // tools. Real per-workspace statuses are threaded through so the handlers'
  // `ensureActiveWorkspace` gate keeps archived matters read-only.
  // Server-executed version-diff tool. Gated on a non-empty workspace set and
  // an active DOCX file field: it resolves version ids against
  // `toolWorkspaceIds` and pins the compared DOCX by the active field's
  // property id.
  const versionCompareTools =
    toolWorkspaceIds.length === 0 ||
    activeFile?.supportsDocxEdits !== true ||
    activeFile.fileFieldId === undefined
      ? {}
      : createVersionCompareTools({
          safeDb,
          organizationId,
          activeFileContext: {
            entityId: activeFile.entityId,
            fileFieldId: activeFile.fileFieldId,
          },
          toolWorkspaceIds,
        });

  const registryWriteTools =
    toolWorkspaceIds.length === 0
      ? {}
      : buildChatWriteTools({
          memberRole,
          organizationId,
          pinServerValidatedWorkspaceId,
          recordAuditEvent,
          refRegistry,
          safeDb,
          scopedDb,
          toolWorkspaceIds,
          userId,
          workspaceStatusById,
        });

  // Delegation is capped at one level: a subagent's own toolset (built by
  // re-invoking `getChatTools` at `delegationDepth + 1`) never registers
  // `spawn_subagents`, so a subagent cannot spawn further subagents. The
  // recursive call also forces `hasActiveDocxEditClient: false`, since a
  // nested loop has no client to satisfy that tool's `addToolResult` contract.
  const delegationDepth = props.delegationDepth ?? 0;
  const subagentTools = areSubagentToolsRegistered({ delegationDepth })
    ? createSpawnSubagentsTool({
        buildSubagentToolset: (proposalSink) =>
          projectToolMapForSubagent(
            getChatTools({
              ...props,
              hasActiveDocxEditClient: false,
              delegationDepth: delegationDepth + 1,
            }),
            proposalSink,
          ),
        organizationId,
        orgAIConfig,
        safeDb,
        thirdPartyBoundary,
        userId,
        workspaceId: requestWorkspaceId,
        threadId,
        delegationDepth,
      })
    : {};

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
      ...createWorkspaceDocumentTools,
      ...editWorkspaceDocumentTools,
      ...activeDocxEditTools,
      ...folioAgentDocTools,
      ...versionCompareTools,
      ...webSearchTools,
      ...registryWriteTools,
      ...externalChatTools,
      ...subagentTools,
    },
  });
};
