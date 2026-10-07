import { panic, Result } from "better-result";

import {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  type BrowserClientCapability,
} from "@stll/api-contract";
import { DOCX_SUGGESTION_SURFACE } from "@stll/api-contract/chat-docx-suggestions";
import type { DocxSuggestionSurface } from "@stll/api-contract/chat-docx-suggestions";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { UsageEventLane } from "@/api/db/schema";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
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
import { createBrowserControlTool } from "@/api/handlers/chat/tools/browser-control-tool";
import { createBusinessRegistryTools } from "@/api/handlers/chat/tools/business-registry-tools";
import { createChatHistoryTools } from "@/api/handlers/chat/tools/chat-history-tools";
import { createCounterpartyCheckTools } from "@/api/handlers/chat/tools/counterparty-check-tools";
import {
  CREATE_DOCUMENT_TOOL_NAME,
  createCreateDocumentTool,
} from "@/api/handlers/chat/tools/create-document-tool";
import { createCreateWorkspaceDocumentTools } from "@/api/handlers/chat/tools/create-workspace-document-tools";
import type { ExcludableChatToolName } from "@/api/handlers/chat/tools/excluded-chat-tools";
import {
  buildChatCodeModeTools,
  type ChatCodeModeToolMap,
  type ChatScriptCallTools,
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
  createPastChatTools,
  PAST_CHAT_SCOPE_TYPE,
  SEARCH_ALL_PAST_CHATS_TOOL_NAME,
  SEARCH_PAST_CHATS_TOOL_NAME,
} from "@/api/handlers/chat/tools/past-chat-tools";
import type { PastChatScope } from "@/api/handlers/chat/tools/past-chat-tools";
import { RAW_MODE_ONLY_CHAT_TOOL_NAMES } from "@/api/handlers/chat/tools/raw-mode-only-tools";
import type { ChatRegistryContextDeps } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import {
  buildChatWriteTools,
  type ChatRegistryWriteToolMap,
} from "@/api/handlers/chat/tools/registry-write-tools";
import {
  createRememberTool,
  REMEMBER_TOOL_NAME,
} from "@/api/handlers/chat/tools/remember-tool";
import { createShowVisualTools } from "@/api/handlers/chat/tools/show-visual-tools";
import {
  createSpawnSubagentsTool,
  SPAWN_SUBAGENTS_TOOL_NAME,
  SUBAGENT_DELEGATION_DEPTH_CAP,
} from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { projectToolMapForSubagent } from "@/api/handlers/chat/tools/subagent-tools";
import {
  createTemplateAuthoringTools,
  createTemplateTools,
  FILL_TEMPLATE_TOOL_NAME,
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
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { FeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import type { SafeId } from "@/api/lib/branded-types";
import { availableRegistryHandlersForOrg } from "@/api/lib/business-registries/credentials";
import type {
  BusinessRegistrySlug,
  RegistryHandler,
} from "@/api/lib/business-registries/dispatch";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { CHAT_TOOL_SET_PURPOSE } from "@/api/lib/chat/chat-tool-types";
import type {
  ChatToolMap,
  ChatToolSetPurpose,
  ChatUIToolsFor,
} from "@/api/lib/chat/chat-tool-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { authorizeDocumentWriteAccess } from "@/api/lib/entities/authorize-document-write";
import type {
  DocumentWriteAccess,
  NewDocumentVersionOperation,
} from "@/api/lib/entities/authorize-document-write";
import { CHAT_ONLY_FEATURE_TOOL_DEFINITIONS } from "@/api/lib/feature-access/registry";
import { FIELD_VALUE_WRITE_PERMISSIONS } from "@/api/lib/fields/write-field";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { ResolvedWebSearchProviders } from "@/api/lib/web-search/select-provider";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { isAccountAuthorizedForMcpTool } from "@/api/mcp/write-tool-authority";

const WEB_SEARCH_NATIVE_TOOL_SLUG = "web-search";

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
  memberRole: AuthorizedMemberRole,
): boolean => hasMemberPermission(memberRole, { template: ["create"] });

type SubagentToolsRegisteredProps = {
  delegationDepth?: number | undefined;
  /**
   * The active skill's `excludedChatTools`, when a skill is active. Naming
   * `spawn_subagents` withholds the tool for the turn: a skill whose flow
   * has the user pick each document before it is read cannot let a
   * subagent, which cannot ask them, read on its behalf.
   */
  excludedChatTools?: readonly ExcludableChatToolName[] | undefined;
};

/**
 * Single source of truth for "is `spawn_subagents` registered on this
 * turn". `getChatTools` uses the same `delegationDepth` comparison and
 * skill exclusion to decide registration; prompt construction uses this
 * predicate to decide whether the delegation section may steer the model
 * to the tool. The skill exclusion is one more reason for `false`, never
 * a reason for `true`: the depth cap holds regardless.
 */
export const areSubagentToolsRegistered = ({
  delegationDepth,
  excludedChatTools,
}: SubagentToolsRegisteredProps): boolean =>
  (delegationDepth ?? 0) < SUBAGENT_DELEGATION_DEPTH_CAP &&
  excludedChatTools?.includes(SPAWN_SUBAGENTS_TOOL_NAME) !== true;

type ResolveRegisteredDocxEditModeOptions = {
  activeFile: GetChatToolsProps["activeFile"];
  editApplyMode: ChatEditApplyMode;
  hasActiveDocxEditClient: boolean;
  memberRole: AuthorizedMemberRole;
  recordAuditEventAvailable: boolean;
  requestWorkspaceId: SafeId<"workspace"> | null;
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
  workspaceStatusById:
    | ReadonlyMap<string, AccessibleWorkspace["status"]>
    | undefined;
};

type ChatRequestWorkspaceOptions = Pick<
  ResolveRegisteredDocxEditModeOptions,
  "requestWorkspaceId" | "toolWorkspaceIds" | "workspaceStatusById"
>;

/** The request's pinned matter as the member sees it, or `null`. */
const chatRequestWorkspace = ({
  requestWorkspaceId,
  toolWorkspaceIds,
  workspaceStatusById,
}: ChatRequestWorkspaceOptions): AccessibleWorkspace | null => {
  if (
    requestWorkspaceId === null ||
    !toolWorkspaceIds.includes(requestWorkspaceId)
  ) {
    return null;
  }
  const status = workspaceStatusById?.get(requestWorkspaceId);
  return status === undefined ? null : { id: requestWorkspaceId, status };
};

type ResolveAutoApplyDocxEditAccessOptions = Omit<
  ResolveRegisteredDocxEditModeOptions,
  "editApplyMode" | "hasActiveDocxEditClient"
>;

/**
 * Write access for the automatic `suggest_changes` variant: an editable
 * active DOCX file with a file field, an audit recorder, and the shared
 * document-write gate for a new version of that file.
 */
const resolveAutoApplyDocxEditAccess = ({
  activeFile,
  memberRole,
  recordAuditEventAvailable,
  requestWorkspaceId,
  toolWorkspaceIds,
  workspaceStatusById,
}: ResolveAutoApplyDocxEditAccessOptions): DocumentWriteAccess<NewDocumentVersionOperation> | null => {
  if (
    activeFile?.supportsDocxEdits !== true ||
    activeFile.fileFieldId === undefined ||
    requestWorkspaceId === null ||
    !recordAuditEventAvailable
  ) {
    return null;
  }
  const access = authorizeDocumentWriteAccess({
    authority: memberRole,
    workspace: chatRequestWorkspace({
      requestWorkspaceId,
      toolWorkspaceIds,
      workspaceStatusById,
    }),
    operation: {
      type: "new_version",
      workspaceId: requestWorkspaceId,
      entityId: activeFile.entityId,
    },
  });
  return Result.isOk(access) ? access.value : null;
};

/**
 * Single source of truth for which mutually exclusive DOCX edit tool is
 * registered on a turn. Prompt construction calls the same predicate, so it
 * cannot direct the model to a tool that authorization or active-file state
 * removed from the tool map.
 */
export const resolveRegisteredDocxEditMode = ({
  editApplyMode,
  hasActiveDocxEditClient,
  ...accessOptions
}: ResolveRegisteredDocxEditModeOptions): ChatEditApplyMode | null => {
  if (editApplyMode === CHAT_EDIT_APPLY_MODE.manual) {
    return hasActiveDocxEditClient ? CHAT_EDIT_APPLY_MODE.manual : null;
  }
  return resolveAutoApplyDocxEditAccess(accessOptions) === null
    ? null
    : CHAT_EDIT_APPLY_MODE.auto;
};

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;
type ChatExecutionTools = ChatCodeModeToolMap;
type SkillTools = ReturnType<typeof createSkillTools>;
type BusinessRegistryTools = ReturnType<typeof createBusinessRegistryTools>;
type CounterpartyCheckTools = ReturnType<typeof createCounterpartyCheckTools>;
type BoeTools = ReturnType<typeof createBoeTools>;
type BrowserControlTools = ReturnType<typeof createBrowserControlTool>;
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
type PastChatTools = ReturnType<typeof createPastChatTools>;
type CurrentSkillEditToolName =
  | "create-current-skill-resource"
  | "update-current-skill-body"
  | "update-current-skill-resource";
type CurrentSkillEditTools = Partial<
  Record<CurrentSkillEditToolName, NonNullable<ChatToolMap[string]>>
>;
type TemplateTools = ReturnType<typeof createTemplateTools>;

/**
 * `fill_template` declares `standard` account access on its MCP definition,
 * as its REST route does: the configured demo account is refused it. Chat
 * reads the same declaration, so that account keeps only the read tools.
 */
const withAccountAuthorizedTemplateFill = (
  tools: TemplateTools,
  userEmail: string,
) => {
  const { [FILL_TEMPLATE_TOOL_NAME]: fillTemplate, ...readTools } = tools;
  const definition =
    getStaticMcpToolDefinition(FILL_TEMPLATE_TOOL_NAME) ??
    panic(`${FILL_TEMPLATE_TOOL_NAME} is missing from the static registry`);
  return {
    ...readTools,
    ...(isAccountAuthorizedForMcpTool(userEmail, definition)
      ? { [FILL_TEMPLATE_TOOL_NAME]: fillTemplate }
      : {}),
  };
};
type TemplateAuthoringTools = ReturnType<typeof createTemplateAuthoringTools>;
type FolderConsistencyReviewTools = ReturnType<
  typeof createFolderConsistencyReviewTools
>;
type RegistryWriteTools = ChatRegistryWriteToolMap;
type SubagentTools = ReturnType<typeof createSpawnSubagentsTool>;
type RememberTools = ReturnType<typeof createRememberTools>;
type ShowVisualTools = ReturnType<typeof createShowVisualTools>;

type BuiltInChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  CurrentSkillEditTools &
  BusinessRegistryTools &
  CounterpartyCheckTools &
  BoeTools &
  BrowserControlTools &
  InfosoudTools &
  WorkspaceTools &
  SuggestChangesTools &
  FolioAgentDocTools &
  CreateDocumentTools &
  CreateWorkspaceDocumentTools &
  WebSearchTools &
  ChatHistoryTools &
  PastChatTools &
  TemplateTools &
  TemplateAuthoringTools &
  FolderConsistencyReviewTools &
  RegistryWriteTools &
  SubagentTools &
  RememberTools &
  ShowVisualTools;

export type ChatTools = BuiltInChatTools;

export type ChatBuiltinApprovalToolName = Exclude<
  keyof ChatUIToolsFor<BuiltInChatTools>,
  "ask-user" | "create-document"
>;

type BuiltInChatToolPolicyName =
  | keyof BuiltInChatTools
  | CurrentSkillEditToolName;

export type GetChatToolsProps = {
  /** Only the owning chat turn can issue and store displayed visual resources. */
  visualTools?: Parameters<typeof createShowVisualTools>[0] | undefined;
  featureAccessSnapshot?: FeatureAccessSnapshot | undefined;
  testDependencies?: ChatRegistryContextDeps["testDependencies"] | undefined;
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
  memberRole: AuthorizedMemberRole;
  // Required (not optional): the template tools eagerly resolve an AI model for
  // usage metering, which needs the org's BYOK config on deployments without a
  // platform provider. A missing value silently falls back and fails there, so
  // every caller must thread it through explicitly.
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
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
  /** Which earlier chats `search-past-chats` reads; see `resolvePastChatScope`. */
  pastChatScope: PastChatScope;
  userId: SafeId<"user">;
  userEmail: string;
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
   * Reads the caller's membership when an approved write runs. Tests inject
   * it; production uses the credential-boundary read.
   */
  resolveCurrentMembership?: Parameters<
    typeof buildChatWriteTools
  >[0]["resolveCurrentMembership"];
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
   * Present only when the requesting web surface has a live, permissioned
   * extension executor; absent means the tool is not registered.
   */
  browserClient?: BrowserClientCapability | undefined;
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
  registryDispatch: Record<BusinessRegistrySlug, RegistryHandler>;
  skillMetadata?: readonly SkillMetadata[] | undefined;
  activeSkillContext?: ActiveChatSkillContext | null | undefined;
  recordAuditEvent?: AuditRecorder | undefined;
  /** Records reads that run without an approval, such as `load-skill`. */
  recordReadAuditEvent?: AuditRecorder | undefined;
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
   * Narrows the finished tool set before it is returned (a subagent's
   * projection). Applied here rather than by the caller so what a code-mode
   * script is told it can call directly is the set the loop really holds.
   */
  projectToolSet?: ((tools: ChatToolMap) => ChatToolMap) | undefined;
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
   * Defaults to `run`. The `validation` set widens every group a run can gate
   * out between two requests on one thread:
   *
   * - DOCX edits: a pending call was issued under the mode selected on the
   *   previous request, so its call/result must remain schema-valid even if the
   *   user changed the composer mode before approving it. Both variants share
   *   the `suggest_changes` name, so widening registers the queue variant
   *   whenever a client surface exists (its schemas admit a persisted call of
   *   either variant) and falls back to the apply variant when only its
   *   preconditions hold. A run still receives exactly one DOCX edit tool.
   * - `remember`: historical calls must remain schema-valid after the
   *   deployment feature is disabled, even though a run must no longer
   *   advertise or execute the tool.
   * - Skill catalog tools: see `createSkillTools`.
   */
  purpose?: ChatToolSetPurpose | undefined;
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
 * Registers `create_matter_document` only when the shared document-write gate
 * admits a create in the request's pinned matter; the tool repeats the
 * per-write step on every call.
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
  if (requestWorkspaceId === null || recordAuditEvent === undefined) {
    return {};
  }
  const access = authorizeDocumentWriteAccess({
    authority: memberRole,
    workspace: chatRequestWorkspace({
      requestWorkspaceId,
      toolWorkspaceIds,
      workspaceStatusById,
    }),
    operation: { type: "create", workspaceId: requestWorkspaceId },
  });
  if (Result.isError(access)) {
    return {};
  }

  return createCreateWorkspaceDocumentTools({
    scopedDb,
    organizationId,
    userId,
    access: access.value,
    recordAuditEvent,
    refRegistry,
  });
};

type CreateAuthorizedWorkspaceToolsProps = Pick<
  GetChatToolsProps,
  | "memberRole"
  | "recordAuditEvent"
  | "refRegistry"
  | "scopedDb"
  | "toolWorkspaceIds"
  | "userId"
  | "workspaceStatusById"
> & { forValidation: boolean };

/**
 * Workspace tools write field values, so they are offered only to a member
 * whose authority covers that write (the field owner re-checks it on every
 * call). Validation keeps them so a persisted call still parses. When the
 * chat is not pinned to any specific matter, `toolWorkspaceIds` is the user's
 * full accessible set; the matter is resolved per-call by the chat client
 * (sticky thread-local matter or matter-pick UI). A chat turn runs on the
 * member's own session, so its authority is the unattenuated role.
 */
const createAuthorizedWorkspaceTools = ({
  forValidation,
  memberRole,
  recordAuditEvent,
  refRegistry,
  scopedDb,
  toolWorkspaceIds,
  userId,
  workspaceStatusById,
}: CreateAuthorizedWorkspaceToolsProps): WorkspaceTools => {
  if (
    !forValidation &&
    !hasMemberPermission(memberRole, FIELD_VALUE_WRITE_PERMISSIONS)
  ) {
    return {};
  }
  return createWorkspaceTools({
    allowedWorkspaceIds: toolWorkspaceIds,
    fieldWriter: {
      authority: memberRole,
      recordAuditEvent,
      userId,
      workspaceStatusById,
    },
    refRegistry,
    scopedDb,
  });
};

const createRememberTools = (
  props: Parameters<typeof createRememberTool>[0],
) => ({
  [REMEMBER_TOOL_NAME]: createRememberTool(props),
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

/**
 * The active skill's chat declarations as a turn's tool set honours them. The
 * streaming set applies both; the validation set ignores both, since neither
 * a read's laziness nor a withheld tool changes how a persisted call parses.
 */
const honouredSkillDeclarations = ({
  activeSkillContext,
  forValidation,
}: {
  activeSkillContext: ActiveChatSkillContext | null | undefined;
  forValidation: boolean;
}): Pick<
  ActiveChatSkillContext,
  "documentedChatReads" | "excludedChatTools"
> =>
  forValidation || !activeSkillContext
    ? { documentedChatReads: [], excludedChatTools: [] }
    : {
        documentedChatReads: activeSkillContext.documentedChatReads,
        excludedChatTools: activeSkillContext.excludedChatTools,
      };

export const getChatTools = (props: GetChatToolsProps): ChatToolMap => {
  const {
    featureAccessSnapshot,
    testDependencies,
    memoryEnabled = isDeploymentFeatureEnabled("FEATURE_AI_MEMORY"),
    safeDb,
    scopedDb,
    pinServerValidatedWorkspaceId,
    organizationId,
    memberRole,
    orgAIConfig,
    managedAIResidency,
    requestWorkspaceId,
    threadId,
    workspaceId,
    excludedChatHistoryMessageIds,
    pastChatScope,
    userId,
    userEmail,
    toolWorkspaceIds,
    activeFile,
    refRegistry,
    toolDefectMemo,
    resolveCurrentMembership,
    thirdPartyBoundary,
    hasActiveDocxEditClient,
    hasActiveDocxFileClient,
    docxSuggestionSurface,
    browserClient,
    webSearchEnabled,
    webSearchProviders,
    externalTools = {},
    disabledNativeToolSlugs,
    registryDispatch,
    skillMetadata,
    activeSkillContext,
    recordAuditEvent,
    recordReadAuditEvent,
    resolveMemorySourceWorkspaceIds,
    workspaceStatusById,
    editApplyMode = DEFAULT_CHAT_EDIT_APPLY_MODE,
    docxEditRepresentation = DEFAULT_DOCX_EDIT_REPRESENTATION,
    purpose = CHAT_TOOL_SET_PURPOSE.run,
    createAIAbortSignal = () => AbortSignal.timeout(120_000),
    promptCachingEnabled = false,
    usageLane,
  } = props;
  const forValidation = purpose === CHAT_TOOL_SET_PURPOSE.validation;
  const skillDeclarations = honouredSkillDeclarations({
    activeSkillContext,
    forValidation,
  });
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
          managedAIResidency,
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
  // bindings are ref-mediated, so no tenant UUID reaches the model. The
  // active skill's documented reads are eager on the streaming set only; the
  // validation set ignores them, as it ignores the exclusion below, since
  // laziness does not change a tool's schema.
  // A script run reads the turn's finished tool set (assigned at the end), so
  // a script that calls a direct tool is told to call it directly.
  let scriptCallTools: ChatScriptCallTools = {
    directTools: [],
    unavailableReasons: new Map(),
  };
  const executionTools = buildChatCodeModeTools({
    featureAccessSnapshot,
    testDependencies,
    documentedReads: skillDeclarations.documentedChatReads,
    memberRole,
    organizationId,
    recordAuditEvent,
    refRegistry,
    safeDb,
    scopedDb,
    scriptCallTools: () => scriptCallTools,
    toolDefectMemo,
    toolWorkspaceIds,
    userId,
    userEmail,
  });
  const skillTools = createSkillTools({
    activeSkillContext,
    organizationId,
    purpose,
    recordAuditEvent,
    recordReadAuditEvent,
    safeDb,
    skills: skillMetadata,
    userId,
  });
  // Unified business-registry tool: register once with a dynamic
  // `jurisdiction` enum derived from the per-adapter native-tool
  // enablement. Adapters are filtered by organization/deployment credential
  // availability, then by org-level native-tool enablement. Empty list means the tool isn't
  // registered at all (no dead picker for the model).
  const businessRegistryHandlers = availableRegistryHandlersForOrg({
    disabledNativeToolSlugs,
    dispatch: registryDispatch,
  });
  const businessRegistryTools = createBusinessRegistryTools({
    organizationId,
    enabledHandlers: businessRegistryHandlers,
  });
  // Findings name natural persons with birth dates and identifiers, which the
  // anonymization boundary cannot redact, so anonymized chat never sees them.
  const counterpartyCheckTools =
    thirdPartyBoundary.type === "raw"
      ? createCounterpartyCheckTools({ scopedDb, organizationId })
      : {};
  const boeDisabled = disabledNativeToolSlugs?.includes("boe") ?? false;
  const boeTools = boeDisabled ? {} : createBoeTools();
  const browserControlTools = browserClient ? createBrowserControlTool() : {};
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
  const autoApplyDocxEditAccess = resolveAutoApplyDocxEditAccess({
    activeFile,
    memberRole,
    recordAuditEventAvailable: recordAuditEvent !== undefined,
    requestWorkspaceId,
    toolWorkspaceIds,
    workspaceStatusById,
  });
  const automaticDocxEditAvailableForValidation =
    forValidation && autoApplyDocxEditAccess !== null;
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
  // panel. Registered ONLY when the session opted into headless apply
  // (`editApplyMode === "auto"`) and `resolveAutoApplyDocxEditAccess` holds:
  // an editable active DOCX file, an audit recorder, and the shared
  // document-write gate (`authorizeDocumentWriteAccess`) for a new version of
  // that file. The tool repeats the per-write step (`authorizeDocumentWrite`)
  // on every call; the remaining narrowings below only refine the types.
  const manualSuggestChangesRegistered =
    registeredDocxEditMode === CHAT_EDIT_APPLY_MODE.manual ||
    (forValidation && hasActiveDocxEditClient);
  const autoApplySuggestChangesTarget =
    !manualSuggestChangesRegistered &&
    (registeredDocxEditMode === CHAT_EDIT_APPLY_MODE.auto ||
      automaticDocxEditAvailableForValidation) &&
    autoApplyDocxEditAccess !== null &&
    activeFile?.currentVersionId !== undefined &&
    activeFile.fileFieldId !== undefined &&
    recordAuditEvent !== undefined
      ? {
          access: autoApplyDocxEditAccess,
          expectedCurrentVersionId: activeFile.currentVersionId,
          fileFieldId: activeFile.fileFieldId,
          recordAuditEvent,
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
    organizationId,
    pastChatScope,
    refRegistry,
    safeDb,
    threadId,
    userId,
  });
  const {
    [SEARCH_PAST_CHATS_TOOL_NAME]: searchPastChatsTool,
    [SEARCH_ALL_PAST_CHATS_TOOL_NAME]: searchAllPastChatsTool,
  } = createPastChatTools({
    organizationId,
    refRegistry,
    safeDb,
    scope: pastChatScope,
    threadId,
    userId,
  });
  // The approval-gated widening only exists when the default search is
  // narrower than all chats. Validation registers it regardless, since a
  // persisted call may come from a turn with a different scope.
  const pastChatTools = {
    [SEARCH_PAST_CHATS_TOOL_NAME]: searchPastChatsTool,
    ...(pastChatScope.type === PAST_CHAT_SCOPE_TYPE.matters || forValidation
      ? { [SEARCH_ALL_PAST_CHATS_TOOL_NAME]: searchAllPastChatsTool }
      : {}),
  };
  // Memory writes audit like the REST memories handlers, so the tool
  // needs a recorder and explicit provenance; callers without either
  // (schema-only construction) get no remember tool rather than an
  // unaudited or cross-matter write path.
  const rememberTools =
    !(memoryEnabled || forValidation) ||
    recordAuditEvent === undefined ||
    resolveMemorySourceWorkspaceIds === undefined
      ? {}
      : createRememberTools({
          authority: memberRole,
          organizationId,
          recordAuditEvent,
          safeDb,
          resolveSourceDataWorkspaceIds: resolveMemorySourceWorkspaceIds,
          toDurableRefText: refRegistry.toDurableRefText,
          userId,
          workspaceId,
          workspaceStatusById,
        });
  const externalChatTools = applyChatToolPolicies({
    defaultPolicyKind: CHAT_TOOL_POLICY_KIND.external,
    tools: externalTools,
  });

  const workspaceTools = createAuthorizedWorkspaceTools({
    forValidation,
    memberRole,
    recordAuditEvent,
    refRegistry,
    scopedDb,
    toolWorkspaceIds,
    userId,
    workspaceStatusById,
  });

  // Template library tools: list, describe, and fill templates. Their
  // execute fns rely on org RLS alone, so gate registration on the same
  // `template: ["use"]` grant the REST fill route enforces; a
  // chat-capable role without it sees no template tools.
  const canUseTemplates = hasMemberPermission(memberRole, {
    template: ["use"],
  });
  const templateTools = canUseTemplates
    ? withAccountAuthorizedTemplateFill(
        createTemplateTools({
          scopedDb,
          safeDb,
          organizationId,
          userId,
          orgAIConfig,
          managedAIResidency,
          recordAuditEvent,
          thirdPartyBoundary,
        }),
        userEmail,
      )
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
        managedAIResidency,
        thirdPartyBoundary,
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
  // request's single pinned/active matter. Chat surfaces with no active
  // matter (e.g. global chat) never see this tool. It also requires
  // `recordAuditEvent`, since `createEntityFromBuffer` always writes an audit
  // event. Permission and matter status come from the shared
  // `authorizeDocumentWriteAccess` gate that REST and MCP document writes use.
  // KNOWN LIMITATION: creates at the matter root every time; there is no
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
  // each behind approval. Registered whatever the caller's matter count: an
  // organization with no matter yet still manages its library, templates,
  // contacts and settings, and creates its first matter here. A write that
  // acts inside a matter answers with a recoverable needs-a-matter result
  // (`matterRequiredResult`) instead of disappearing. Each tool's declared
  // write permissions gate its registration; handlers keep their
  // input-specific role checks. Real per-workspace statuses are threaded through so the
  // handlers' `ensureActiveWorkspace` gate keeps archived matters read-only.
  const registryWriteTools = buildChatWriteTools({
    featureAccessSnapshot,
    testDependencies,
    memberRole,
    organizationId,
    pinServerValidatedWorkspaceId,
    recordAuditEvent,
    refRegistry,
    ...(resolveCurrentMembership === undefined
      ? {}
      : { resolveCurrentMembership }),
    safeDb,
    scopedDb,
    toolDefectMemo,
    toolWorkspaceIds,
    userId,
    userEmail,
    workspaceStatusById,
  });

  // Delegation is capped at one level: a subagent's own toolset (built by
  // re-invoking `getChatTools` at `delegationDepth + 1`) never registers
  // `spawn_subagents`, so a subagent cannot spawn further subagents. The
  // recursive call also forces `hasActiveDocxEditClient: false`, since a
  // nested loop has no client to satisfy that tool's `addToolResult` contract.
  // The active skill's exclusion narrows the streaming set only: the
  // validation set stays broad so a thread that used `spawn_subagents`
  // before the skill was activated still hydrates.
  const delegationDepth = props.delegationDepth ?? 0;
  const subagentTools = areSubagentToolsRegistered({
    delegationDepth,
    excludedChatTools: skillDeclarations.excludedChatTools,
  })
    ? createSpawnSubagentsTool({
        buildSubagentToolset: (proposalSink) =>
          getChatTools({
            ...props,
            browserClient: undefined,
            visualTools: undefined,
            hasActiveDocxEditClient: false,
            delegationDepth: delegationDepth + 1,
            projectToolSet: (tools) =>
              projectToolMapForSubagent(tools, proposalSink),
          }),
        organizationId,
        orgAIConfig,
        managedAIResidency,
        safeDb,
        thirdPartyBoundary,
        userId,
        workspaceId: requestWorkspaceId,
        threadId,
        delegationDepth,
      })
    : {};

  const registered = applyChatToolPolicies({
    policyKinds,
    tools: {
      ...(props.visualTools === undefined
        ? {}
        : createShowVisualTools(props.visualTools)),
      ...orgTools,
      ...executionTools,
      ...skillTools,
      ...businessRegistryTools,
      ...counterpartyCheckTools,
      ...boeTools,
      ...browserControlTools,
      ...infosoudTools,
      ...workspaceTools,
      ...templateTools,
      ...templateAuthoringTools,
      ...historyTools,
      ...pastChatTools,
      ...rememberTools,
      ...createDocumentTools,
      ...createWorkspaceDocumentTools,
      ...suggestChangesTools,
      ...folioAgentDocTools,
      ...folderConsistencyReviewTools,
      ...webSearchTools,
      ...registryWriteTools,
      ...externalChatTools,
      ...subagentTools,
    },
  });
  const projected = props.projectToolSet?.(registered) ?? registered;
  const tools = Object.fromEntries(
    Object.entries(projected).filter(([name]) =>
      isMcpDescriptorFeatureEnabled({
        context: {
          featureAccessSnapshot,
          testDependencies,
          organizationId,
          userId,
        },
        kind: "tools",
        id: name,
        featureId:
          CHAT_ONLY_FEATURE_TOOL_DEFINITIONS.find(
            (definition) => definition.name === name,
          )?.featureId ?? getStaticMcpToolDefinition(name)?.featureId,
      }),
    ),
  );
  scriptCallTools = {
    directTools: Object.keys(tools),
    unavailableReasons: new Map([
      ...(thirdPartyBoundary.type === "raw"
        ? []
        : RAW_MODE_ONLY_CHAT_TOOL_NAMES.map(
            (name) => [name, "anonymized mode is on"] as const,
          )),
      ...(webResearchAvailable
        ? []
        : [WEB_SEARCH_TOOL_NAME, FETCH_URL_TOOL_NAME].map(
            (name) => [name, "web research is off for this chat"] as const,
          )),
      ...Object.keys(registered)
        .filter((name) => !(name in projected))
        .map((name) => [name, "subagents cannot call it"] as const),
    ]),
  };
  return tools;
};

type GetChatValidationToolsProps = Omit<
  GetChatToolsProps,
  | "featureAccessSnapshot"
  | "docxSuggestionSurface"
  | "hasActiveDocxEditClient"
  | "hasActiveDocxFileClient"
  | "purpose"
  | "skillMetadata"
  | "thirdPartyBoundary"
> & {
  featureAccessSnapshot: GetChatToolsProps["featureAccessSnapshot"];
};

/**
 * The tool set an incoming message's tool calls are validated against. It
 * never executes, so every surface- and catalog-dependent group is registered
 * at its widest: for any request, this set must contain every tool a run on
 * the same thread could have exposed under the current caller access. The
 * snapshot property is explicit so request wiring cannot omit its decision.
 */
export const getChatValidationTools = (
  props: GetChatValidationToolsProps,
): ChatToolMap =>
  getChatTools({
    ...props,
    purpose: CHAT_TOOL_SET_PURPOSE.validation,
    // `spawn_subagents` never executes here, so a raw (non-anonymizing)
    // boundary is correct; it also keeps the raw-only folder review tool.
    thirdPartyBoundary: { type: "raw" },
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient: true,
    // Persisted calls may come from either surface; the file overlay's
    // operation set is the superset.
    docxSuggestionSurface: DOCX_SUGGESTION_SURFACE.fileOverlay,
  });
