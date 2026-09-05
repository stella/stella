import {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  type ApprovalRequiredBuiltInChatToolName,
  type BuiltInChatToolPolicyKindByName,
} from "@stll/api-contract";
import type { DocxSuggestionSurface } from "@stll/api-contract/chat-docx-suggestions";
import { roles } from "@stll/permissions";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { UsageEventLane } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  CHAT_EDIT_APPLY_MODE,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  type ChatEditApplyMode,
  type DocxEditRepresentation,
} from "@/api/handlers/chat/chat-schema";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createAutoApplySuggestChangesTools } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import { createBoeTools } from "@/api/handlers/chat/tools/boe-tools";
import { createBusinessRegistryTools } from "@/api/handlers/chat/tools/business-registry-tools";
import { createChatHistoryTools } from "@/api/handlers/chat/tools/chat-history-tools";
import {
  CREATE_DOCUMENT_TOOL_NAME,
  createCreateDocumentTool,
} from "@/api/handlers/chat/tools/create-document-tool";
import { createCreateWorkspaceDocumentTools } from "@/api/handlers/chat/tools/create-workspace-document-tools";
import {
  buildChatCodeModeTools,
  type ChatCodeModeToolMap,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { createFolderConsistencyReviewTools } from "@/api/handlers/chat/tools/folder-consistency-review-tool";
import {
  createFolioAgentDocTools,
  createSuggestChangesTools,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import {
  buildChatWriteTools,
  type ChatRegistryWriteToolMap,
} from "@/api/handlers/chat/tools/registry-write-tools";
import {
  createRememberTool,
  REMEMBER_TOOL_NAME,
} from "@/api/handlers/chat/tools/remember-tool";
import {
  createSpawnSubagentsTool,
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
import { createVersionCompareTools } from "@/api/handlers/chat/tools/version-compare-tools";
import { createWebSearchTools } from "@/api/handlers/chat/tools/web-search-tools";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { getChatSkillMetadata } from "@/api/lib/agent-skills/skills";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { enabledRegistryHandlersForOrg } from "@/api/lib/business-registries/dispatch";
import type {
  ChatToolMap,
  ChatUIToolsFor,
} from "@/api/lib/chat/chat-tool-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
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
/**
 * `suggest_changes` is one tool name with two registrations: the manual,
 * client-executed queue variant and the automatic, server-executed apply
 * variant. A union (not an intersection) so `ChatUITools` sees both shapes.
 */
type SuggestChangesTools =
  | ReturnType<typeof createSuggestChangesTools>
  | ReturnType<typeof createAutoApplySuggestChangesTools>;
type FolioAgentDocTools = ReturnType<typeof createFolioAgentDocTools>;
type CreateDocumentTools = ReturnType<typeof createCreateDocumentTools>;
type CreateWorkspaceDocumentTools = ReturnType<
  typeof createCreateWorkspaceDocumentTools
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
type FolderConsistencyReviewTools = ReturnType<
  typeof createFolderConsistencyReviewTools
>;
type RegistryWriteTools = ChatRegistryWriteToolMap;
type SubagentTools = ReturnType<typeof createSpawnSubagentsTool>;
type RememberTools = ReturnType<typeof createRememberTools>;

type BuiltInChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  CurrentSkillEditTools &
  BusinessRegistryTools &
  BoeTools &
  InfosoudTools &
  WorkspaceTools &
  SuggestChangesTools &
  FolioAgentDocTools &
  CreateDocumentTools &
  CreateWorkspaceDocumentTools &
  WebSearchTools &
  ChatHistoryTools &
  TemplateTools &
  TemplateAuthoringTools &
  VersionCompareTools &
  FolderConsistencyReviewTools &
  RegistryWriteTools &
  SubagentTools &
  RememberTools;

export type ChatTools = BuiltInChatTools;

export type ChatBuiltinApprovalToolName = Exclude<
  keyof ChatUIToolsFor<BuiltInChatTools>,
  "ask-user" | "create-document"
>;

type BuiltInChatToolPolicyName =
  | keyof BuiltInChatTools
  | CurrentSkillEditToolName;

type GetChatToolsProps = {
  /** Deployment gate; injectable so both disabled and enabled toolsets test. */
  memoryEnabled?: boolean | undefined;
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
  /**
   * The matter this chat is bound to, when any. `null` for global
   * chats. Distinct from `toolWorkspaceIds` (the read-authorized
   * matter set): this is the single matter that scopes workspace
   * memory writes via the `remember` tool.
   */
  workspaceId: SafeId<"workspace"> | null;
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
   * The turn's server-defect memo, shared by every toolset built for this
   * turn (validation, streaming, and subagents via the props re-spread) so a
   * call refused as defective in one toolset stays refused in the others.
   */
  toolDefectMemo: ChatToolDefectMemo;
  /**
   * The turn's anonymization boundary. Threaded into
   * `createSpawnSubagentsTool` so each subagent's own model calls cross
   * the same anonymize/deanonymize boundary as the parent turn; the
   * recursive `buildSubagentToolset` call re-spreads `props`, so nested
   * levels inherit it automatically.
   */
  thirdPartyBoundary: ChatThirdPartyBoundary;
  /**
   * `true` when the request comes from a surface that has a
   * `suggest_changes` client executor mounted (the file overlay's
   * review-queue bridge or the Template Studio's in-document
   * suggestion bridge). Other surfaces (standalone chat, global chat)
   * MUST NOT see this tool: the server has no `execute` for it, the
   * client never calls TanStack ChatClient.addToolResult, and the call
   * would hang.
   */
  hasActiveDocxEditClient: boolean;
  /**
   * `true` only for the file overlay: `activeFile.supportsDocxEdits`,
   * with no Template Studio fallback. Narrower than
   * `hasActiveDocxEditClient` on purpose — only `file-chat-overlay.tsx`
   * mounts the live-editor bridge that resolves the folio-agents read
   * and comment tools via `addToolResult`. Template Studio has no
   * editor ref, so registering those tools there would hang the turn
   * waiting for a client result that never arrives. Gates
   * `createFolioAgentDocTools()` registration below and picks the
   * `suggest_changes` surface options; `suggest_changes` itself stays
   * on the combined `hasActiveDocxEditClient` flag since Template
   * Studio does handle that one.
   */
  hasActiveDocxFileClient: boolean;
  /**
   * Which client executor resolves `suggest_changes` this turn, and so
   * which per-surface schema the model sees. Not derivable from the two
   * flags above: an unsaved generated draft is hosted by the file overlay
   * (full operation set) without being an entity-backed active file.
   */
  docxSuggestionSurface: DocxSuggestionSurface;
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
   * Execution-time matter provenance for durable memories created during this
   * turn. The resolver must include the initial prompt/thread scope and refs
   * registered by tools or subagents before the memory write.
   */
  resolveMemorySourceWorkspaceIds?:
    | (() => readonly SafeId<"workspace">[])
    | undefined;
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
   * tracked changes by default). Picks which `suggest_changes` variant is
   * registered: the manual, client-executed queue variant or the automatic,
   * server-executed apply variant -- exactly one per turn, never both.
   * Neither registers when the apply variant's own preconditions (an
   * entity-backed active DOCX file, `entity:update`, active matter) fail to
   * hold in "auto" mode -- e.g. Template Studio, which has no entity-backed
   * `activeFile`, must explicitly pass "manual" to keep its DOCX-edit tool.
   */
  editApplyMode?: ChatEditApplyMode | undefined;
  /**
   * Redline representation the automatic `suggest_changes` variant applies
   * operations with; defaults to `DEFAULT_DOCX_EDIT_REPRESENTATION`.
   * Ignored in `manual` mode.
   */
  docxEditRepresentation?: DocxEditRepresentation | undefined;
  /**
   * Validation-only widening for continuation messages. A pending DOCX tool
   * call was issued under the mode selected on the previous request, so its
   * call/result must remain schema-valid even if the user changed the composer
   * mode before approving it. Both variants share the `suggest_changes` name,
   * so widening registers the queue variant whenever a client surface exists
   * (its schemas admit a persisted call of either variant) and falls back to
   * the apply variant when only its preconditions hold. Live streaming
   * callers must leave this false so the model still receives exactly one
   * DOCX edit tool.
   */
  includeAllDocxEditToolsForValidation?: boolean | undefined;
  /**
   * Validation-only compatibility for persisted turns. Historical `remember`
   * calls must remain schema-valid after the deployment feature is disabled,
   * even though the live provider toolset must no longer advertise or execute
   * the tool.
   */
  includeRememberToolForValidation?: boolean | undefined;
  /** Fresh abort budget for server-side tools that make their own AI request. */
  createAIAbortSignal?: (() => AbortSignal) | undefined;
  /** Preserve the request's provider prompt-cache setting in nested review. */
  promptCachingEnabled?: boolean | undefined;
  usageLane?: UsageEventLane | undefined;
};

const createCreateDocumentTools = () => ({
  [CREATE_DOCUMENT_TOOL_NAME]: createCreateDocumentTool(),
});

type CreateWorkspaceDocumentChatToolsProps = Pick<
  GetChatToolsProps,
  | "memberRole"
  | "organizationId"
  | "recordAuditEvent"
  | "refRegistry"
  | "requestWorkspaceId"
  | "scopedDb"
  | "toolWorkspaceIds"
  | "userId"
  | "workspaceStatusById"
>;

/**
 * Mirrors the REST/MCP entity-create boundary for the direct chat mutation.
 * Keeping the full gate here prevents registration from drifting away from
 * the authorization required by its execution path.
 */
const createAuthorizedWorkspaceDocumentTools = ({
  memberRole,
  organizationId,
  recordAuditEvent,
  refRegistry,
  requestWorkspaceId,
  scopedDb,
  toolWorkspaceIds,
  userId,
  workspaceStatusById,
}: CreateWorkspaceDocumentChatToolsProps): ChatToolMap => {
  if (
    requestWorkspaceId === null ||
    recordAuditEvent === undefined ||
    !toolWorkspaceIds.includes(requestWorkspaceId) ||
    workspaceStatusById?.get(requestWorkspaceId) !== "active" ||
    !roles[memberRole].authorize({ entity: ["create"] }).success
  ) {
    return {};
  }

  return createCreateWorkspaceDocumentTools({
    scopedDb,
    organizationId,
    userId,
    workspaceId: requestWorkspaceId,
    recordAuditEvent,
    refRegistry,
  });
};

type CreateRememberToolsProps = {
  canManageWorkspaceMemory: boolean;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  resolveSourceDataWorkspaceIds: () => readonly SafeId<"workspace">[];
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const createRememberTools = ({
  canManageWorkspaceMemory,
  organizationId,
  recordAuditEvent,
  safeDb,
  resolveSourceDataWorkspaceIds,
  userId,
  workspaceId,
}: CreateRememberToolsProps) => ({
  [REMEMBER_TOOL_NAME]: createRememberTool({
    canManageWorkspaceMemory,
    organizationId,
    recordAuditEvent,
    safeDb,
    resolveSourceDataWorkspaceIds,
    userId,
    workspaceId,
  }),
});

/* Contract-owned so browser approval UX and server enforcement cannot drift. */
BUILT_IN_CHAT_TOOL_POLICY_KINDS satisfies Record<
  BuiltInChatToolPolicyName,
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND]
>;
true satisfies Exclude<
  keyof typeof BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  BuiltInChatToolPolicyName
> extends never
  ? true
  : never;

/** Every built-in chat tool's policy kind, keyed by tool name. Single source
 * of truth consumers (e.g. the web client) derive their own tool-name unions
 * from, instead of hand-mirroring this classification. */
export type { BuiltInChatToolPolicyKindByName };

/**
 * Built-in tool names whose policy kind requires approval, derived from
 * {@link BuiltInChatToolPolicyKindByName} and {@link NeedsApprovalPolicyKind}
 * rather than hand-listed, so a reclassified tool moves in or out of this
 * union automatically.
 */
export type { ApprovalRequiredBuiltInChatToolName };

export const getChatTools = (props: GetChatToolsProps): ChatToolMap => {
  const {
    memoryEnabled = env.FEATURE_AI_MEMORY,
    safeDb,
    scopedDb,
    pinServerValidatedWorkspaceId,
    organizationId,
    memberRole,
    orgAIConfig,
    requestWorkspaceId,
    threadId,
    workspaceId,
    excludedChatHistoryMessageIds,
    userId,
    toolWorkspaceIds,
    activeFile,
    refRegistry,
    toolDefectMemo,
    thirdPartyBoundary,
    hasActiveDocxEditClient,
    hasActiveDocxFileClient,
    docxSuggestionSurface,
    webSearchEnabled,
    webSearchProviders,
    externalTools = {},
    disabledNativeToolSlugs,
    skillMetadata,
    activeSkillContext,
    recordAuditEvent,
    resolveMemorySourceWorkspaceIds,
    workspaceStatusById,
    editApplyMode = DEFAULT_CHAT_EDIT_APPLY_MODE,
    docxEditRepresentation = DEFAULT_DOCX_EDIT_REPRESENTATION,
    includeAllDocxEditToolsForValidation = false,
    includeRememberToolForValidation = false,
    createAIAbortSignal = () => AbortSignal.timeout(120_000),
    promptCachingEnabled = false,
    usageLane,
  } = props;
  const orgTools = createOrgTools({
    accessibleWorkspaceIds: toolWorkspaceIds,
    organizationId,
    scopedDb,
  });
  // The nested review request sends the selected documents to the configured
  // model. Until that request accepts the chat anonymization boundary, do not
  // advertise a tool whose raw file reads would contradict anonymized mode.
  const folderConsistencyReviewTools =
    thirdPartyBoundary.type === "raw"
      ? createFolderConsistencyReviewTools({
          createAbortSignal: createAIAbortSignal,
          organizationId,
          orgAIConfig,
          promptCachingEnabled,
          refRegistry,
          safeDb,
          toolWorkspaceIds,
          userId,
          usageLane,
        })
      : {};
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
    toolDefectMemo,
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
  const businessRegistryJurisdictions = enabledRegistryHandlersForOrg(
    disabledNativeToolSlugs,
  ).map((handler) => handler.country);
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
  // Exactly one `suggest_changes` registration per turn.
  //
  // Manual: the client-executed queue variant. The file overlay queues into
  // the review panel with the full operation set; Template Studio renders
  // in-document text replacements only, so it gets the narrower schema.
  // Same tool, per-surface options. Validation widening also lands here:
  // its raw JSON Schema input and absent output schema admit a persisted
  // call of either variant, whereas the apply variant's output schema would
  // reject a persisted queue result.
  //
  // Auto: the server-executed apply variant. It writes a new entity
  // version directly instead of queuing suggestions into the browser review
  // panel, so it needs its own explicit authorization mirror rather than
  // inheriting one from the queue variant (which has none of its own -- it
  // never writes). Registered ONLY when every one of these holds:
  //   - `editApplyMode === "auto"`: the session opted into headless apply
  //     (see `editApplyMode`'s doc comment on `GetChatToolsProps`).
  //   - An editable active DOCX file is present
  //     (`activeFile.supportsDocxEdits === true`), the same precondition
  //     `compare_versions` uses, with its current version id to pin the
  //     batch to.
  //   - `entity: ["update"]` permission -- this tool overwrites the active
  //     document's content, the same grant `docx-suggestions/create.ts`,
  //     `resolve.ts`, and `upload-version.ts` require for DOCX edits.
  //     `create_matter_document` checks `entity: ["create"]` instead
  //     because it creates a new document; this tool edits an existing
  //     one, so it checks the "update" action, not "create".
  //   - Active (non-archived) matter status, from the same
  //     `workspaceStatusById` map `create_matter_document` reads, so an
  //     archived matter stays read-only through this tool too.
  //   - `recordAuditEvent` present, since `createEntityVersionFromBuffer`
  //     always writes an audit event.
  // (`resolveRegisteredDocxEditMode` checks the role, matter, and file
  // preconditions; the remaining narrowings below only refine the types.)
  const manualSuggestChangesRegistered =
    registeredDocxEditMode === CHAT_EDIT_APPLY_MODE.manual ||
    (includeAllDocxEditToolsForValidation && hasActiveDocxEditClient);
  const autoApplySuggestChangesTarget =
    !manualSuggestChangesRegistered &&
    (registeredDocxEditMode === CHAT_EDIT_APPLY_MODE.auto ||
      automaticDocxEditAvailableForValidation) &&
    activeFile?.currentVersionId !== undefined &&
    activeFile.fileFieldId !== undefined &&
    requestWorkspaceId !== null &&
    recordAuditEvent !== undefined
      ? {
          entityId: activeFile.entityId,
          expectedCurrentVersionId: activeFile.currentVersionId,
          fileFieldId: activeFile.fileFieldId,
          recordAuditEvent,
          workspaceId: requestWorkspaceId,
        }
      : null;
  const resolveSuggestChangesTools = () => {
    if (manualSuggestChangesRegistered) {
      return createSuggestChangesTools(docxSuggestionSurface);
    }
    if (autoApplySuggestChangesTarget === null) {
      return {};
    }
    return createAutoApplySuggestChangesTools({
      ...autoApplySuggestChangesTarget,
      safeDb,
      organizationId,
      userId,
      docxEditRepresentation,
    });
  };
  const suggestChangesTools = resolveSuggestChangesTools();
  // The contract classifies `suggest_changes` as a mutation for the apply
  // variant. The queue variant never writes (the per-suggestion Accept is
  // the human gate), so it runs without a chat-level approval.
  const policyKinds = {
    ...BUILT_IN_CHAT_TOOL_POLICY_KINDS,
    [SUGGEST_CHANGES_TOOL_NAME]: manualSuggestChangesRegistered
      ? CHAT_TOOL_POLICY_KIND.internal
      : BUILT_IN_CHAT_TOOL_POLICY_KINDS[SUGGEST_CHANGES_TOOL_NAME],
  };
  // Narrower than `suggest_changes` above: only the file overlay mounts
  // the live-editor bridge that resolves these via `addToolResult` (see
  // `hasActiveDocxFileClient` doc comment). Template Studio has no editor
  // ref, so the tools must stay unregistered there rather than hang
  // waiting for a client result.
  const folioAgentDocTools = hasActiveDocxFileClient
    ? createFolioAgentDocTools()
    : {};
  const historyTools = createChatHistoryTools({
    excludedMessageIds: excludedChatHistoryMessageIds,
    refRegistry,
    safeDb,
    threadId,
  });
  // Memory writes audit like the REST memories handlers, so the tool
  // needs a recorder and explicit provenance; callers without either
  // (schema-only construction) get no remember tool rather than an
  // unaudited or cross-matter write path.
  const rememberTools =
    !(memoryEnabled || includeRememberToolForValidation) ||
    recordAuditEvent === undefined ||
    resolveMemorySourceWorkspaceIds === undefined
      ? {}
      : createRememberTools({
          canManageWorkspaceMemory:
            roles[memberRole].authorize({
              workspace: ["update"],
            }).success &&
            workspaceId !== null &&
            workspaceStatusById?.get(workspaceId) === "active",
          organizationId,
          recordAuditEvent,
          safeDb,
          resolveSourceDataWorkspaceIds: resolveMemorySourceWorkspaceIds,
          userId,
          workspaceId,
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
    refRegistry,
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

  // create_matter_document is server-executed (immediate, no client
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
  const createWorkspaceDocumentTools = createAuthorizedWorkspaceDocumentTools({
    memberRole,
    organizationId,
    recordAuditEvent,
    refRegistry,
    requestWorkspaceId,
    scopedDb,
    toolWorkspaceIds,
    userId,
    workspaceStatusById,
  });

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
          toolDefectMemo,
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
    policyKinds,
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
      ...rememberTools,
      ...createDocumentTools,
      ...createWorkspaceDocumentTools,
      ...suggestChangesTools,
      ...folioAgentDocTools,
      ...versionCompareTools,
      ...folderConsistencyReviewTools,
      ...webSearchTools,
      ...registryWriteTools,
      ...externalChatTools,
      ...subagentTools,
    },
  });
};
