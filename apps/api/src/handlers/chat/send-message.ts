import { panic, Result } from "better-result";
import type { InferOk } from "better-result";
import { deepEquals } from "bun";
import { and, eq } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  CHAT_TURN_INTENT,
  CHAT_TURN_NOT_OWNED_ERROR_CODE,
  resourceRef,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import {
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
} from "@stll/api-contract/action-admission";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, SafeDbError, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  getActiveFileModelBinding,
  type ActiveFileModelBinding,
  type ActiveFileSourceForModel,
} from "@/api/handlers/chat/active-file-model-source";
import {
  resolveActiveChatSkillContext,
  type ActiveChatSkillContext,
} from "@/api/handlers/chat/active-skill-context";
import {
  chatMessageFromPersisted,
  getAwaitingUserInteractions,
  getResumedUserInteraction,
  isChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  finalizeAssistantTurn,
  persistAcceptedMessageWithClaim,
  persistClaimedReplayMessage,
  persistFailedChatTurn,
  persistInterruptedChatTurn,
  persistMessage,
  persistStoppedChatTurn,
  persistTerminalAssistantTurn,
} from "@/api/handlers/chat/chat-message-persistence";
import {
  appendAnonymizedModeHintToChatSafePrompt,
  buildChatPromptCacheKey,
  buildChatSystemPromptParts,
  chatVolatilePromptSection,
  extendChatUntrustedPromptSuffix,
  extractTitle,
} from "@/api/handlers/chat/chat-prompt";
import type {
  ChatSafePromptLayers,
  ChatToolAvailability,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
import {
  chatRefsWrittenIn,
  toolCallIdsOf,
} from "@/api/handlers/chat/chat-refs-shown";
import { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
import type {
  ChatSendRequest,
  IncomingActiveDecision,
  IncomingActiveDraft,
  IncomingActiveExternal,
  IncomingActiveFile,
  IncomingActiveStatute,
  IncomingActiveTemplate,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import {
  CHAT_EDIT_APPLY_MODE,
  CHAT_RUN_MODE,
  agUiSendMessageBodySchema,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  parseMessage,
  resolveBrowserClientCapability,
  validateToolCallParts,
  validateMessage,
} from "@/api/handlers/chat/chat-schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  bindChatTurnRunId,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  CHAT_METERED_PROVIDER_TIMEOUT_MS,
  isChatTurnNotOwned,
  isChatTurnRunIdTaken,
  startChatTurnRun,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import {
  CHAT_TURN_BOUNDARY_MODE,
  ChatTurnRun,
  countChatTurnSettlement,
  processChatTurnOwnership,
} from "@/api/handlers/chat/chat-turn-run";
import type {
  ChatTurnObservation,
  ChatTurnStoredSettlement,
} from "@/api/handlers/chat/chat-turn-run";
import {
  CUT_SHORT_OUTCOME,
  settleHistoryForRun,
} from "@/api/handlers/chat/chat-turn-settlement";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import { COMPACTION_SUMMARY_MESSAGE_ID } from "@/api/handlers/chat/compaction";
import {
  computeAssistantTurnWorkspaceIds,
  extractIncomingMessageWorkspaceIds,
  extractThreadDataWorkspaceIds,
} from "@/api/handlers/chat/data-scope";
import { ChatError } from "@/api/handlers/chat/errors";
import { generateThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import {
  chatMessageExistsForThread,
  resolveTruncationTarget,
} from "@/api/handlers/chat/history-window";
import { isExternalMcpToolPart } from "@/api/handlers/chat/mcp-tool-parts";
import { loadClientMessages } from "@/api/handlers/chat/message-page";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import { planMessagePersistence } from "@/api/handlers/chat/persist-message";
import { loadRequestedSkillsPrompt } from "@/api/handlers/chat/requested-skills-prompt";
import {
  compactMessagesForContext,
  markChatCompactionDue,
  selectMessagesForContextInput,
} from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import {
  loadThread,
  readThreadValidationState,
} from "@/api/handlers/chat/send-message-thread";
import type { ChatThreadState } from "@/api/handlers/chat/send-message-thread";
import { hydrateMessages, streamChat } from "@/api/handlers/chat/stream-chat";
import type { StreamChatFinishEvent } from "@/api/handlers/chat/stream-chat";
import type { StoredHistory } from "@/api/handlers/chat/stream-message-identity";
import {
  createChatThirdPartyBoundary,
  storedRestorationsOf,
} from "@/api/handlers/chat/third-party-boundary";
import {
  createToolReadScopeRecorder,
  recordToolReadScope,
} from "@/api/handlers/chat/tool-read-scope";
import {
  intersectAccessibleWorkspaceIds,
  resolveToolWorkspaceIds,
} from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { hasSuggestChangesApprovalResponse } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import { resolveChatDocumentClients } from "@/api/handlers/chat/tools/chat-document-clients";
import {
  areSubagentToolsRegistered,
  areTemplateAuthoringToolsRegistered,
  areWebResearchToolsRegistered,
  getChatTools,
  getChatValidationTools,
  resolveRegisteredDocxEditMode,
} from "@/api/handlers/chat/tools/chat-tools";
import {
  buildExternalMcpSystemHint,
  createLazyExternalMcpToolsLoader,
  loadExternalMcpToolsForUser,
} from "@/api/handlers/chat/tools/external-mcp-tools";
import type {
  LazyExternalMcpToolsLoader,
  LoadedExternalMcpTools,
} from "@/api/handlers/chat/tools/external-mcp-tools";
import {
  PAST_CHAT_SCOPE_TYPE,
  resolvePastChatScope,
} from "@/api/handlers/chat/tools/past-chat-tools";
import {
  hydrateRegistryToolInputRefs,
  resolveRegistryToolInputRefs,
} from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import {
  hydrateRegistryToolOutputRefs,
  resolveRegistryToolOutputRefs,
} from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
import {
  chatToolNamesForSkills,
  type ChatSkillToolContext,
} from "@/api/handlers/chat/tools/skill-tool-availability";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import {
  type ChatToolScope,
  restrictChatToolsToScope,
  scopeAllowsTool,
} from "@/api/handlers/chat/tools/tool-scope";
import type {
  ChatMention,
  ChatMessage,
  ChatPart,
  PersistableChatMessage,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import { createRawChatFilePart } from "@/api/handlers/chat/upload-files";
import type { UploadedChatFile } from "@/api/handlers/chat/upload-files";
import { attachVerifiedEntityMentionKinds } from "@/api/handlers/chat/verified-mention-kinds";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { createVisualStore } from "@/api/handlers/visual-sandbox/store";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError, detached } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  ACCOUNT_ACCESS,
  authorizeHandlerUsage,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { FeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { getOrganizationRegistryDispatch } from "@/api/lib/business-registries/credentials";
import { resolveEffectiveChatModelSelection } from "@/api/lib/chat-model-selection";
import {
  canUseChatThreadForGeneratedDocumentDraft,
  createGeneratedDocumentActiveDraftContext,
  hasPersistedGeneratedDocumentActiveDraftContext,
} from "@/api/lib/chat/active-draft-context";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { registeredChatTool } from "@/api/lib/chat/chat-tool-types";
import { isReadyGeneratedDocumentDraft } from "@/api/lib/chat/created-draft";
import { expandThreadDataScope } from "@/api/lib/chat/data-scope";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_ENCODING,
  CHAT_REF_INPUT_STATE,
  isChatRefContext,
  resolveChatRefInputState,
  type ChatEntityRefContext,
  type ChatRefBinding,
  type ChatRefContext,
  type ChatRefInputState,
  type ChatUnresolvedInputRefContext,
} from "@/api/lib/chat/ref-token";
import {
  type ChatThreadNamesRead,
  readChatThreadNames,
} from "@/api/lib/chat/thread-names";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { rewriteWorkspaceUrlsToMentions } from "@/api/lib/chat/workspace-url-mentions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { createFileKey } from "@/api/lib/files/utils";
import {
  FILE_SIZE_LIMIT_BYTES,
  FILE_SIZE_LIMITS,
  LIMITS,
} from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import { getDisabledNativeToolSlugs } from "@/api/lib/mcp-connectors/catalog-metadata";
import { resolveMemorySourceWorkspaceIds } from "@/api/lib/memory/memory-provenance";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
} from "@/api/lib/rate-limit/action-admission";
import { startExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import type { ExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import {
  requireTanStackAIAvailableForRole,
  validateTanStackDevModelOverride,
} from "@/api/lib/tanstack-ai-models";
import type { UsageLaneDecision } from "@/api/lib/usage/lane-routing";
import { previewVisual } from "@/api/lib/visual-preview";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { isLocalDevOpen } from "@/api/runtime-mode";

const COMPLETED_TURN_FOLLOW_UPS_FAILED = failureSink({
  event: "chat.turn.completed_follow_ups_failed",
  expected: [],
});

/**
 * Dev model overrides (`body.devModelId`) are local-only: reject them outside
 * dev, otherwise validate the override against the org's provider config.
 */
const assertDevModelOverride = (
  devModelId: string | undefined,
  orgAIConfig: OrgAIConfig | null,
): Result<void, HandlerError<400>> => {
  if (!devModelId) {
    return Result.ok(undefined);
  }
  if (!isLocalDevOpen()) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Dev model overrides are only available locally.",
      }),
    );
  }
  return validateTanStackDevModelOverride(devModelId, orgAIConfig);
};

type SubagentToolsAvailableForTurnOptions = {
  /** The turn's active skill, resolved from the same request the streaming
   *  tool set is built from, so the prompt flag and the tool agree. */
  activeSkillContext: ActiveChatSkillContext | null;
  toolScope: ChatToolScope | undefined;
};

/**
 * Whether the delegation tool is offered on this turn: only at the top level,
 * only when the turn's scope (if any) allows `spawn_subagents`, and only when
 * the active skill (if any) does not exclude it. Kept as a top-level helper so
 * the streaming handler stays within its cognitive-complexity budget.
 */
export const areSubagentToolsAvailableForTurn = ({
  activeSkillContext,
  toolScope,
}: SubagentToolsAvailableForTurnOptions): boolean =>
  areSubagentToolsRegistered({
    delegationDepth: 0,
    excludedChatTools: activeSkillContext?.excludedChatTools,
  }) &&
  (toolScope === undefined ||
    scopeAllowsTool(toolScope, SPAWN_SUBAGENTS_TOOL_NAME));

const normalizeOptionalArray = <T>(value: T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }
  return value;
};

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Processes document inputs in the chat operation and returns its response stream.",
  },
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "realtime_stream" },
  body: agUiSendMessageBodySchema,
  requiresUsage: { actionType: "chat", laneRouting: true },
} satisfies HandlerConfig;

/** IDs of workspaces the chat may touch; deleting workspaces are excluded. */
const usableWorkspaceIds = (
  workspaces: readonly AccessibleWorkspace[],
): AccessibleWorkspace["id"][] => {
  const ids: AccessibleWorkspace["id"][] = [];
  for (const workspace of workspaces) {
    if (workspace.status !== "deleting") {
      ids.push(workspace.id);
    }
  }
  return ids;
};

const validateActiveDraftContext = async ({
  activeDraft,
  organizationId,
  safeDb,
  userId,
}: {
  activeDraft: IncomingActiveDraft | undefined;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<
  Result<
    { originDataWorkspaceIds: readonly SafeId<"workspace">[] } | null,
    HandlerError<404> | SafeDbError
  >
> => {
  if (activeDraft === undefined) {
    return Result.ok(null);
  }
  const rows = await safeDb((tx) =>
    tx
      .select({
        content: chatMessages.content,
        dataWorkspaceIds: chatThreads.dataWorkspaceIds,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.id, activeDraft.originChatMessageId),
          eq(chatThreads.id, activeDraft.originChatThreadId),
          eq(chatThreads.userId, userId),
          eq(chatThreads.organizationId, organizationId),
        ),
      )
      .limit(1),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }
  const originMessage = rows.value.at(0);
  if (
    originMessage?.role !== "assistant" ||
    !isReadyGeneratedDocumentDraft({
      persistedContent: originMessage.content,
      fileName: activeDraft.fileName,
      toolCallId: activeDraft.toolCallId,
    })
  ) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Active generated document draft not found",
      }),
    );
  }

  return Result.ok({
    originDataWorkspaceIds: originMessage.dataWorkspaceIds,
  });
};

const stampValidatedMessageWithActiveDraftContext = ({
  activeDraft,
  message,
}: {
  activeDraft: IncomingActiveDraft | undefined;
  message: PersistableChatMessage;
}): PersistableChatMessage => {
  if (activeDraft === undefined) {
    return message;
  }

  return toPersistableChatMessage({
    id: message.id,
    role: message.role,
    parts: message.parts,
    ...(message.createdAt === undefined
      ? {}
      : { createdAt: message.createdAt }),
    metadata: {
      ...message.metadata,
      activeDraftContext: createGeneratedDocumentActiveDraftContext({
        originChatMessageId: activeDraft.originChatMessageId,
        originChatThreadId: activeDraft.originChatThreadId,
        toolCallId: activeDraft.toolCallId,
      }),
    },
  });
};

type ClaimedChatTurnOwnership =
  | { status: "unclaimed" }
  | {
      status: "preflight";
      execution: ChatTurnExecution;
      owningAssistantMessage?: PersistableChatMessage | undefined;
    }
  | {
      status: "failure-pending";
      execution: ChatTurnExecution;
      failure: { code: ChatTurnFailureCode; retryable: boolean };
      owningAssistantMessage?: PersistableChatMessage | undefined;
    }
  | { status: "handed-over" };

type ChatSendLifecycleOptions = {
  startAdmission?: typeof startExecutionAdmission;
  indexThread: typeof upsertChatThreadSearchDocument;
  externalMcpToolsLoader: LazyExternalMcpToolsLoader;
  /** The boundary mode the turn's settlement is counted under. */
  mode: ChatTurnObservation["mode"];
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  rollbackSideEffects: typeof rollbackUnpersistedChatSideEffects;
};

/**
 * Why a streamed turn could not be persisted: the failure code its turn row
 * records and the error the stream reports to the client.
 */
type AssistantTurnFailure = {
  code: ChatTurnFailureCode;
  error: HandlerError<500>;
};

/** What a stored, completed turn's follow-ups read. */
type CompletedTurnFollowUps = {
  messagesAfterAssistantPersist: ReturnType<
    typeof applyAssistantPersistencePlan
  >;
  resolvedResponseMessage: ChatMessage;
};

/**
 * A streamed turn's `onFinish` boundary. The response is already streaming,
 * so no outer catch settles the turn: without this it stays `running` until
 * its lease lapses and the thread is dead. One boundary for every failure,
 * expected or thrown, so the turn row is settled exactly once before the
 * stream reports the error. Returns what the row now holds, for the run to
 * count.
 */
const settleStreamedAssistantTurn = async ({
  persist,
  run,
  runFollowUps,
  threadId,
}: {
  persist: () => Promise<
    Result<
      {
        followUps: CompletedTurnFollowUps | null;
        settlement: ChatTurnStoredSettlement;
      },
      AssistantTurnFailure
    >
  >;
  run: ChatTurnRun;
  runFollowUps: (followUps: CompletedTurnFollowUps) => Promise<void>;
  threadId: SafeId<"chatThread">;
}): Promise<ChatTurnStoredSettlement> => {
  const settled = (
    await Result.tryPromise({
      try: persist,
      catch: (cause): AssistantTurnFailure => ({
        code: "internal",
        error: new HandlerError({
          status: 500,
          message: "Failed to settle assistant turn",
          cause,
        }),
      }),
    })
  ).andThen((result) => result);
  if (Result.isError(settled)) {
    const { code, error } = settled.error;
    await run.fail(code, true);
    throw error;
  }
  // The turn is stored from here, so a follow-up that throws is reported and
  // never reaches the boundary above: a completed turn cannot then read as
  // failed.
  const { followUps, settlement } = settled.value;
  if (followUps !== null) {
    const followedUp = await Result.tryPromise(
      async () => await runFollowUps(followUps),
    );
    if (Result.isError(followedUp)) {
      observeFailure(followedUp.error, {
        sink: COMPLETED_TURN_FOLLOW_UPS_FAILED,
        ctx: { threadId },
      });
    }
  }
  return settlement;
};

const CHECKPOINT_RESTORATION_FAILED = failureSink({
  event: "chat.send.checkpoint_restoration_failed",
  expected: [],
});

const CHAT_SEND_ACTION_KIND = "chat.send";

/**
 * Owns every resource that must be settled when a send stops before its run
 * starts. Starting the run hands the claimed turn over for good.
 */
export class ChatSendLifecycle {
  private readonly options: ChatSendLifecycleOptions;
  private admission: ExecutionAdmission | undefined;
  private checkpoint: PersistableChatMessage | undefined;
  private claimedTurn: ClaimedChatTurnOwnership = { status: "unclaimed" };
  /** Ends this process's record of the claim; a no-op once ended. */
  private releaseClaim: () => void = () => undefined;
  private connectorsHandedOff = false;
  private pendingSideEffects:
    | {
        threadState: ChatThreadState;
        uploadedFiles: UploadedChatFile[];
      }
    | undefined;

  constructor(options: ChatSendLifecycleOptions) {
    this.options = options;
  }

  /**
   * Count a turn settled before its run started, once its row holds the
   * outcome. No model is resolved yet. A turn another owner settled first is
   * not this send's to count, and a settlement that failed leaves the turn
   * claimed, for `cleanup` to store and count once.
   */
  private countPreflightSettlement(
    outcome: "cancelled" | "failed" | "interrupted",
    failureCode: ChatTurnFailureCode | null,
    settlement: Result<unknown, unknown>,
  ): void {
    if (Result.isError(settlement)) {
      return;
    }
    countChatTurnSettlement(
      { mode: this.options.mode, provider: "none" },
      outcome,
      failureCode,
    );
  }

  adoptThread(threadState: ChatThreadState): void {
    this.pendingSideEffects = { threadState, uploadedFiles: [] };
  }

  trackUploadedFiles(uploadedFiles: UploadedChatFile[]): void {
    if (this.pendingSideEffects === undefined) {
      panic("Cannot track chat uploads without rollback ownership");
    }
    this.pendingSideEffects.uploadedFiles = uploadedFiles;
  }

  releaseSideEffects(): void {
    this.pendingSideEffects = undefined;
  }

  claimTurn(
    execution: ChatTurnExecution,
    owningAssistantMessage: PersistableChatMessage | undefined,
  ): void {
    this.claimedTurn = {
      status: "preflight",
      execution,
      ...(owningAssistantMessage === undefined
        ? {}
        : { owningAssistantMessage }),
    };
    this.releaseClaim = processChatTurnOwnership.holdClaim({
      execution,
      safeDb: this.options.safeDb,
    });
  }

  async admitExecution({
    organizationId,
    checkpoint,
  }: {
    organizationId: SafeId<"organization">;
    checkpoint: PersistableChatMessage | undefined;
  }): Promise<Result<ModelDispatchAdmission, HandlerError>> {
    const acquired = await (
      this.options.startAdmission ?? startExecutionAdmission
    )({
      organizationId,
      userId: this.options.userId,
      mode: "concurrency-only",
      actionKind: "chat.send",
    });
    if (Result.isError(acquired)) {
      return acquired;
    }
    this.admission = acquired.value;
    this.checkpoint = checkpoint;
    return Result.ok(acquired.value.modelAdmission);
  }

  async reserveExecutionPeriod(
    runId: string,
  ): Promise<Result<void, HandlerError>> {
    if (this.claimedTurn.status !== "preflight") {
      panic("Cannot reserve a phase without a durable execution owner");
    }
    if (this.admission === undefined) {
      return Result.ok(undefined);
    }
    return await this.admission.reservePeriod(
      {
        actionKind: CHAT_SEND_ACTION_KIND,
        logicalPhaseId: JSON.stringify([this.claimedTurn.execution.id, runId]),
      },
      this.options.scopedDb,
    );
  }

  get admissionSignal(): AbortSignal | undefined {
    return this.admission?.signal;
  }

  async checkAdmission(): Promise<Result<void, HandlerError>> {
    if (!this.admission?.signal.aborted) {
      return Result.ok(undefined);
    }
    const error: unknown = this.admission.signal.reason;
    const refusal = new HandlerError({
      ...(ActionAdmissionError.is(error)
        ? actionAdmissionRefusal(error)
        : {
            status: 503 as const,
            code: "service_unavailable",
            message: "Action admission is unavailable",
          }),
      cause: error,
    });
    if (
      this.claimedTurn.status === "preflight" &&
      !(await this.restorePreExecutionCheckpoint())
    ) {
      const settled = await this.refuseCurrentTurn(refusal);
      if (Result.isError(settled)) {
        return settled;
      }
    }
    return Result.err(refusal);
  }

  private async restorePreExecutionCheckpoint(): Promise<boolean> {
    if (
      (this.claimedTurn.status !== "preflight" &&
        this.claimedTurn.status !== "failure-pending") ||
      !this.admission?.signal.aborted ||
      this.checkpoint === undefined
    ) {
      return false;
    }
    const interaction = getAwaitingUserInteractions(this.checkpoint).at(0);
    if (interaction === undefined) {
      return false;
    }
    // No tools have executed before handoff. Restore only this original
    // awaiting snapshot, through the same execution fence as normal settlement.
    const restored = await persistTerminalAssistantTurn({
      indexThread: this.options.indexThread,
      execution: this.claimedTurn.execution,
      outcome: { type: "awaiting-user", interaction },
      owningAssistantMessage: this.checkpoint,
      recordAuditEvent: this.options.recordAuditEvent,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
    });
    if (Result.isError(restored)) {
      observeFailure(restored.error, {
        sink: CHECKPOINT_RESTORATION_FAILED,
        ctx: {
          source: "chat-admission-checkpoint-restoration",
          threadId: this.options.threadId,
        },
      });
    } else {
      this.claimedTurn = { status: "unclaimed" };
    }
    return true;
  }

  /**
   * Hand the claimed turn to its run, with the connector clients the run's
   * tools use: from here the run alone settles the turn and closes them. The
   * run gets nothing of the request, so it behaves the same once the request
   * is gone.
   */
  startRun(connectors: LoadedExternalMcpTools | undefined): ChatTurnRun {
    if (this.claimedTurn.status !== "preflight") {
      return panic("Cannot start a run for a turn this send does not hold");
    }
    const run = new ChatTurnRun({
      admission: this.admission,
      checkpoint: this.checkpoint,
      connectors,
      deadlineMs: CHAT_METERED_PROVIDER_TIMEOUT_MS,
      mode: this.options.mode,
      owner: {
        indexThread: this.options.indexThread,
        execution: this.claimedTurn.execution,
        owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
        recordAuditEvent: this.options.recordAuditEvent,
        safeDb: this.options.safeDb,
        threadId: this.options.threadId,
        userId: this.options.userId,
        workspaceId: this.options.workspaceId,
      },
    });
    this.claimedTurn = { status: "handed-over" };
    this.releaseClaim();
    this.connectorsHandedOff = connectors !== undefined;
    return run;
  }

  async failCurrentTurn(
    code: ChatTurnFailureCode,
    retryable: boolean,
  ): Promise<void> {
    if (this.claimedTurn.status !== "preflight") {
      panic("Cannot fail a chat turn this send does not hold");
    }
    if (await this.restorePreExecutionCheckpoint()) {
      return;
    }
    const failureResult = await persistFailedChatTurn({
      code,
      execution: this.claimedTurn.execution,
      indexThread: this.options.indexThread,
      recordAuditEvent: this.options.recordAuditEvent,
      retryable,
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
    });
    this.countPreflightSettlement("failed", code, failureResult);
    if (Result.isError(failureResult)) {
      this.claimedTurn = {
        status: "failure-pending",
        execution: this.claimedTurn.execution,
        failure: { code, retryable },
        ...(this.claimedTurn.owningAssistantMessage === undefined
          ? {}
          : {
              owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
            }),
      };
      captureError(failureResult.error, { threadId: this.options.threadId });
      return;
    }
    this.claimedTurn = { status: "unclaimed" };
  }

  async refuseCurrentTurn(
    error: HandlerError,
  ): Promise<Result<void, HandlerError>> {
    if (this.claimedTurn.status !== "preflight") {
      panic("Cannot refuse a chat turn this send does not hold");
    }
    const settled = await persistTerminalAssistantTurn({
      execution: this.claimedTurn.execution,
      failure: { code: "boundary-refusal", retryable: false },
      outcome: isActionAdmissionCode(error.code)
        ? {
            type: "failed",
            error: "unknown",
            refusal: {
              ...ACTION_ADMISSION_REFUSALS[error.code],
              code: error.code,
              ...(error.hint === undefined ? {} : { hint: error.hint }),
              ...(error.contactUrl === undefined
                ? {}
                : { contactUrl: error.contactUrl }),
            },
          }
        : {
            type: "failed",
            error:
              error.status === 429 ? "quota_exhausted" : "provider_unavailable",
          },
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
      recordAuditEvent: this.options.recordAuditEvent,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
      indexThread: this.options.indexThread,
    });
    if (Result.isError(settled)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to store the refused chat turn",
          cause: settled.error,
        }),
      );
    }
    this.claimedTurn = { status: "unclaimed" };
    return Result.ok(undefined);
  }

  /** The user stopped the turn before its provider call started. */
  async stopCurrentTurn() {
    if (this.claimedTurn.status !== "preflight") {
      return panic("Cannot stop a chat turn this send does not hold");
    }
    const settlementResult = await persistStoppedChatTurn({
      execution: this.claimedTurn.execution,
      indexThread: this.options.indexThread,
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
      recordAuditEvent: this.options.recordAuditEvent,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
    });
    if (Result.isOk(settlementResult)) {
      this.countPreflightSettlement("cancelled", null, settlementResult);
      this.claimedTurn = { status: "unclaimed" };
    }
    return settlementResult;
  }

  async interruptCurrentTurn() {
    if (this.claimedTurn.status !== "preflight") {
      return panic("Cannot interrupt a chat turn this send does not hold");
    }
    if (await this.restorePreExecutionCheckpoint()) {
      return Result.ok(undefined);
    }
    const settlementResult = await persistInterruptedChatTurn({
      execution: this.claimedTurn.execution,
      indexThread: this.options.indexThread,
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
      recordAuditEvent: this.options.recordAuditEvent,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
    });
    if (Result.isOk(settlementResult)) {
      this.countPreflightSettlement("interrupted", null, settlementResult);
      this.claimedTurn = { status: "unclaimed" };
    }
    return settlementResult;
  }

  async cleanup(): Promise<void> {
    try {
      const failureToPersist = await (async () => {
        // Admission can be lost while a failed settlement write is in flight.
        // Its original pending interaction still owns the turn in that case.
        if (await this.restorePreExecutionCheckpoint()) {
          return undefined;
        }
        switch (this.claimedTurn.status) {
          case "failure-pending":
            return this.claimedTurn;
          case "preflight":
            return {
              status: "failure-pending" as const,
              execution: this.claimedTurn.execution,
              failure: { code: "internal" as const, retryable: true },
              ...(this.claimedTurn.owningAssistantMessage === undefined
                ? {}
                : {
                    owningAssistantMessage:
                      this.claimedTurn.owningAssistantMessage,
                  }),
            };
          case "unclaimed":
          case "handed-over":
            return undefined;
          default:
            this.claimedTurn satisfies never;
            return panic(`Unhandled claimed turn: ${String(this.claimedTurn)}`);
        }
      })();
      if (failureToPersist !== undefined) {
        const failureResult = await persistFailedChatTurn({
          code: failureToPersist.failure.code,
          execution: failureToPersist.execution,
          indexThread: this.options.indexThread,
          owningAssistantMessage: failureToPersist.owningAssistantMessage,
          recordAuditEvent: this.options.recordAuditEvent,
          retryable: failureToPersist.failure.retryable,
          safeDb: this.options.safeDb,
          threadId: this.options.threadId,
          userId: this.options.userId,
          workspaceId: this.options.workspaceId,
        });
        this.countPreflightSettlement(
          "failed",
          failureToPersist.failure.code,
          failureResult,
        );
        if (Result.isError(failureResult)) {
          captureError(failureResult.error, {
            source: "send-message-claimed-turn-preflight-cleanup",
            threadId: this.options.threadId,
          });
        }
      }
      if (this.pendingSideEffects !== undefined) {
        const rollbackResult = await this.options.rollbackSideEffects({
          recordAuditEvent: this.options.recordAuditEvent,
          safeDb: this.options.safeDb,
          threadId: this.options.threadId,
          threadState: this.pendingSideEffects.threadState,
          uploadedFiles: this.pendingSideEffects.uploadedFiles,
          userId: this.options.userId,
        });
        if (Result.isError(rollbackResult)) {
          captureError(rollbackResult.error, {
            source: "send-message-unpersisted-side-effect-rollback",
            threadId: this.options.threadId,
          });
        }
      }
      if (!this.connectorsHandedOff) {
        await this.options.externalMcpToolsLoader.closeIfLoaded();
      }
    } finally {
      this.releaseClaim();
      if (this.claimedTurn.status !== "handed-over") {
        await this.admission?.release();
      }
    }
  }
}

/**
 * Establish durable run ownership before pre-dispatch work, then recheck the
 * connection and execution owner immediately before streaming. A stop during
 * preparation ends the turn here. Every refusal leaves the turn settled.
 */
const prepareDispatch = async ({
  phase,
  execution,
  isClientConnectionAborted,
  lifecycle,
  runId,
  safeDb,
}: {
  phase: "bind" | "dispatch";
  execution: ChatTurnExecution;
  isClientConnectionAborted: () => boolean;
  lifecycle: ChatSendLifecycle;
  runId: string;
  safeDb: SafeDb;
}): Promise<Result<void, HandlerError<400 | 409 | 500>>> => {
  if (isClientConnectionAborted()) {
    await lifecycle.failCurrentTurn("internal", true);
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Client disconnected before stream started",
      }),
    );
  }
  const writeRun = phase === "bind" ? bindChatTurnRunId : startChatTurnRun;
  const leaseRenewal = await writeRun({
    execution,
    runId,
    safeDb,
  });
  if (Result.isError(leaseRenewal)) {
    await lifecycle.failCurrentTurn("internal", true);
    return Result.err(
      new HandlerError({
        status: 500,
        message:
          phase === "bind"
            ? "Failed to bind chat run"
            : "Failed to renew chat execution lease",
        cause: leaseRenewal.error,
      }),
    );
  }
  switch (leaseRenewal.value) {
    case "owned":
      return Result.ok(undefined);
    case "stop-requested": {
      const stopped = await lifecycle.stopCurrentTurn();
      if (Result.isError(stopped)) {
        await lifecycle.failCurrentTurn("internal", true);
        return Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to store the stopped chat turn",
            cause: stopped.error,
          }),
        );
      }
      return Result.err(
        new HandlerError({
          code: CHAT_TURN_NOT_OWNED_ERROR_CODE,
          status: 409,
          message: "Chat turn was stopped",
        }),
      );
    }
    case "lost":
      await lifecycle.failCurrentTurn("internal", true);
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Chat turn lost its durable execution owner",
        }),
      );
    case "run-taken":
      await lifecycle.failCurrentTurn("internal", false);
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The run id already names another chat turn",
        }),
      );
    default:
      leaseRenewal.value satisfies never;
      return panic(`Unhandled standing: ${String(leaseRenewal.value)}`);
  }
};

type ThreadValidationState = InferOk<
  Awaited<ReturnType<typeof readThreadValidationState>>
>;

type CreateTurnVisualOriginOptions = {
  incomingMessage: Pick<PersistableChatMessage, "id" | "role">;
  persistedMessage: ThreadValidationState["persistedMessage"];
};

const createTurnVisualOrigin = ({
  incomingMessage,
  persistedMessage,
}: CreateTurnVisualOriginOptions) =>
  createVisualResourceOrigin({
    persistedParts:
      incomingMessage.role === "assistant" &&
      persistedMessage?.role === "assistant"
        ? chatMessageFromPersisted({
            content: persistedMessage.content,
            id: incomingMessage.id,
            role: persistedMessage.role,
          }).parts
        : [],
  });

type AcceptIncomingTurnOptions = {
  accessibleSet: ReadonlySet<string>;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  body: ChatSendRequest;
  effectiveContextMatterIds: SafeId<"workspace">[];
  lifecycle: ChatSendLifecycle;
  organizationId: SafeId<"organization">;
  managedAIResidency: ManagedAIResidency;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  thread: ChatThreadState;
  uploadedMessage: PersistableChatMessage;
  userId: SafeId<"user">;
  validationThreadState: ThreadValidationState;
  workspaceId: SafeId<"workspace"> | null;
  indexThread: typeof upsertChatThreadSearchDocument;
};

/** Persists the incoming message and establishes the turn's durable owner. */
const acceptIncomingTurn = async ({
  accessibleSet,
  accessibleWorkspaceIds,
  body,
  effectiveContextMatterIds,
  lifecycle,
  organizationId,
  managedAIResidency,
  recordAuditEvent,
  safeDb,
  thread,
  uploadedMessage,
  userId,
  validationThreadState,
  workspaceId,
  indexThread,
}: AcceptIncomingTurnOptions) =>
  await Result.gen(async function* () {
    const parsedMessage = parseMessage({
      accessibleWorkspaceIds,
      message: uploadedMessage,
    });
    const isExplicitRegeneration =
      body.turnIntent === CHAT_TURN_INTENT.regenerate;
    if (
      isExplicitRegeneration &&
      (parsedMessage.message.role !== "user" ||
        body.truncateAfterMessageId !== undefined)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Regeneration requires one unambiguous user-message target",
        }),
      );
    }
    const replayTargetMessageId =
      body.truncateAfterMessageId ??
      (isExplicitRegeneration ? parsedMessage.message.id : undefined);

    let messagesForPersistence: ChatThreadState["data"]["messages"] =
      thread.data.messages;
    // Every decision below reads this history; acceptance holds the turn to it.
    let plannedOnHistory = thread.data.historySnapshot;
    let deleteMessageIdsBeforeLatest: SafeId<"chatMessage">[] = [];
    let incomingMessageExists = false;
    if (replayTargetMessageId !== undefined) {
      if (parsedMessage.message.id !== replayTargetMessageId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Truncation target must match the incoming message",
          }),
        );
      }
      const truncationTarget = yield* Result.await(
        resolveTruncationTarget({
          safeDb,
          threadId: body.threadId,
          targetMessageId: replayTargetMessageId,
        }),
      );
      if (truncationTarget === null) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Truncation target was not found in the chat thread",
          }),
        );
      }
      messagesForPersistence = truncationTarget.messagesForPersistence;
      plannedOnHistory = truncationTarget.snapshot;
      deleteMessageIdsBeforeLatest =
        truncationTarget.deleteMessageIdsBeforeLatest;
      if (isExplicitRegeneration && truncationTarget.hasLaterUserMessage) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Only the latest user turn can be regenerated",
          }),
        );
      }
    } else {
      incomingMessageExists = yield* Result.await(
        chatMessageExistsForThread({
          messageId: brandPersistedChatMessageId(parsedMessage.message.id),
          safeDb,
          threadId: body.threadId,
        }),
      );
    }

    const baseLatestMessagePlan = planMessagePersistence({
      message: parsedMessage.message,
      storedMessages: messagesForPersistence,
      incomingMessageExists,
    });
    if (
      isExplicitRegeneration &&
      baseLatestMessagePlan.persistencePlan.type !== "none"
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Regeneration target is not a persisted user message",
        }),
      );
    }
    const latestMessagePlan = isExplicitRegeneration
      ? {
          existingIds: baseLatestMessagePlan.existingIds,
          messages: baseLatestMessagePlan.messages,
          persistencePlan: {
            message: parsedMessage.message,
            messageId: parsedMessage.message.id,
            type: "update",
          } satisfies MessagePersistencePlan,
        }
      : baseLatestMessagePlan;
    if (
      replayTargetMessageId !== undefined &&
      latestMessagePlan.persistencePlan.type !== "update"
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Truncation requires updating an existing message",
        }),
      );
    }

    const recomputedDataWorkspaceIds =
      replayTargetMessageId === undefined
        ? null
        : recomputeThreadDataScope({
            accessibleSet,
            baseWorkspaceId: workspaceId,
            messages: latestMessagePlan.messages,
          });
    const incomingMessageWorkspaceIds = extractIncomingMessageWorkspaceIds({
      mentions: parsedMessage.mentions,
      message: parsedMessage.message,
    }).filter((id) => accessibleSet.has(id));
    const dataScopeAfterIncomingMessage =
      recomputedDataWorkspaceIds ??
      Array.from(
        new Set([
          ...thread.data.dataWorkspaceIds,
          ...incomingMessageWorkspaceIds,
        ]),
      );
    const toolWorkspaceIds = resolveToolWorkspaceIds({
      pinnedIds: effectiveContextMatterIds,
      accessibleWorkspaceIds,
    });
    const sandboxRunResult =
      body.runMode === CHAT_RUN_MODE.agent
        ? await Result.tryPromise({
            try: async () =>
              await resolveChatSandboxPlan({
                dataClass: "customer",
                managedAIResidency,
                organizationId,
                runId: Bun.randomUUIDv7(),
                userId,
                workspaceIds: toolWorkspaceIds,
              }),
            catch: (cause) =>
              cause instanceof HandlerError
                ? cause
                : new HandlerError({
                    cause,
                    message: "Failed to prepare agent sandbox run",
                    status: 500,
                  }),
          })
        : Result.ok(undefined);
    if (Result.isError(sandboxRunResult)) {
      return yield* Result.err(sandboxRunResult.error);
    }
    const sandboxRun = sandboxRunResult.value;
    const turnAcceptance =
      parsedMessage.message.role === "user" &&
      latestMessagePlan.persistencePlan.type !== "none"
        ? createChatTurnAcceptance({
            organizationId,
            threadId: body.threadId,
            userId,
            userMessageId: parsedMessage.message.id,
            workspaceId,
          })
        : undefined;
    const persistenceProps = {
      acceptedSendMode: body.sendMode,
      recordAuditEvent,
      safeDb,
      threadId: body.threadId,
      turnAcceptance,
      userId,
      workspaceId,
      persistencePlan: latestMessagePlan.persistencePlan,
      dataScopeExpansion:
        recomputedDataWorkspaceIds === null
          ? { newWorkspaceIds: incomingMessageWorkspaceIds }
          : undefined,
      deleteMessageIds: deleteMessageIdsBeforeLatest,
      dataScopeReplacement:
        recomputedDataWorkspaceIds === null
          ? undefined
          : {
              observedDataWorkspaceIds: thread.data.dataWorkspaceIds,
              newDataWorkspaceIds: recomputedDataWorkspaceIds,
            },
      indexThread,
    } as const;

    let turnExecution: ChatTurnExecution | null;
    let superseded: PersistableTerminalAssistantMessage | undefined;
    if (parsedMessage.message.role === "assistant") {
      if (latestMessagePlan.persistencePlan.type !== "update") {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Interactive replay must update its owning message",
          }),
        );
      }
      const replayResult = await persistClaimedReplayMessage({
        ...persistenceProps,
        claim: {
          acceptedTurnId: null,
          continuationInteraction:
            getResumedUserInteraction({
              awaited: getAwaitingUserInteractions(
                validationThreadState.persistedMessage === null
                  ? null
                  : chatMessageFromPersisted({
                      content: validationThreadState.persistedMessage.content,
                      id: parsedMessage.message.id,
                      role: validationThreadState.persistedMessage.role,
                    }),
              ),
              message: parsedMessage.message,
            }) ?? undefined,
          incomingMessageId: parsedMessage.message.id,
          incomingMessageRole: parsedMessage.message.role,
          organizationId,
          threadId: body.threadId,
          userId,
          workspaceId,
        },
        persistencePlan: latestMessagePlan.persistencePlan,
      });
      if (Result.isError(replayResult)) {
        return Result.err(replayResult.error);
      }
      turnExecution = replayResult.value;
      if (turnExecution !== null) {
        lifecycle.releaseSideEffects();
      }
    } else if (turnAcceptance === undefined) {
      const persistenceResult = await persistMessage(persistenceProps);
      if (Result.isError(persistenceResult)) {
        return Result.err(persistenceResult.error);
      }
      turnExecution = yield* Result.await(
        claimChatTurnForExecution({
          acceptedTurnId: null,
          incomingMessageId: parsedMessage.message.id,
          incomingMessageRole: parsedMessage.message.role,
          organizationId,
          safeDb,
          threadId: body.threadId,
          userId,
          workspaceId,
        }),
      );
    } else {
      const persistenceResult = await persistAcceptedMessageWithClaim({
        ...persistenceProps,
        plannedOnHistory,
        turnAcceptance,
      });
      if (Result.isError(persistenceResult)) {
        return Result.err(persistenceResult.error);
      }
      ({ execution: turnExecution, superseded } = persistenceResult.value);
    }
    if (
      parsedMessage.message.role !== "assistant" &&
      latestMessagePlan.persistencePlan.type !== "none"
    ) {
      lifecycle.releaseSideEffects();
    }
    if (turnExecution === null) {
      return Result.err(
        new HandlerError({
          code: CHAT_TURN_NOT_OWNED_ERROR_CODE,
          status: 409,
          message: "Chat turn has no durable execution owner",
        }),
      );
    }
    const owningAssistantMessage =
      parsedMessage.message.role === "assistant"
        ? parsedMessage.message
        : undefined;
    lifecycle.claimTurn(turnExecution, owningAssistantMessage);
    const supersededMessage = superseded;
    return Result.ok({
      dataScopeAfterIncomingMessage,
      deleteMessageIdsBeforeLatest,
      // The run continues the thread as accepting the turn stored it.
      latestMessagePlan:
        supersededMessage === undefined
          ? latestMessagePlan
          : {
              ...latestMessagePlan,
              messages: latestMessagePlan.messages.map((message) =>
                message.id === supersededMessage.id
                  ? supersededMessage
                  : message,
              ),
            },
      owningAssistantMessage,
      parsedMessage,
      replayTargetMessageId,
      // The messages accepting the turn rewrote, which the page holds.
      rewrittenOnAcceptance:
        supersededMessage === undefined ? [] : [supersededMessage.id],
      sandboxRun,
      toolWorkspaceIds,
      turnExecution,
    });
  });

type LoadStoredHistoryOptions = {
  /** Every stored message the run was handed except the one it continues. */
  historyIds: readonly SafeId<"chatMessage">[];
  /** The messages accepting the turn rewrote. */
  rewrittenOnAcceptance: readonly SafeId<"chatMessage">[];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

/** What the client is shown of a run's history as stored, read the way the
 *  thread's page serves it. */
const loadStoredHistory = async ({
  historyIds,
  rewrittenOnAcceptance,
  safeDb,
  threadId,
  userId,
}: LoadStoredHistoryOptions): Promise<Result<StoredHistory, SafeDbError>> => {
  const loadServed = async (messageIds: readonly SafeId<"chatMessage">[]) =>
    await loadClientMessages({ messageIds, safeDb, threadId, userId });
  const rewritten = await loadServed(rewrittenOnAcceptance);
  if (Result.isError(rewritten)) {
    return Result.err(rewritten.error);
  }
  if (rewritten.value.length !== rewrittenOnAcceptance.length) {
    panic("A stored message the run was handed is gone");
  }
  return Result.ok({
    loadServed: async () => {
      const served = await loadServed(historyIds);
      if (Result.isError(served)) {
        return Result.err(served.error);
      }
      return Result.ok(
        new Map(served.value.map((message) => [message.id, message])),
      );
    },
    rewrittenOnAcceptance: rewritten.value,
  });
};

type ChatToolsInput = Parameters<typeof getChatTools>[0];

type PrepareValidatedIncomingMessageOptions = {
  dependencies: {
    loadWebSearchProviders: typeof loadWebSearchProvidersForOrg;
    uploadMessageFiles: typeof uploadMessageFilesWithRollback;
  };
  authorization: {
    accessibleWorkspaceIds: SafeId<"workspace">[];
    memberRole: ChatToolsInput["memberRole"];
    pinServerValidatedWorkspaceId: ChatToolsInput["pinServerValidatedWorkspaceId"];
    requestedContextMatterIds: SafeId<"workspace">[];
    workspaceStatusById: NonNullable<ChatToolsInput["workspaceStatusById"]>;
  };
  lifecycle: ChatSendLifecycle;
  persistence: {
    recordAuditEvent: AuditRecorder;
    safeDb: SafeDb;
    scopedDb: ChatToolsInput["scopedDb"];
  };
  prerequisites: {
    activeDraftContext: InferOk<
      Awaited<ReturnType<typeof validateActiveDraftContext>>
    >;
    activeFileForTools: ChatToolsInput["activeFile"];
    validationThreadState: ThreadValidationState;
  };
  request: {
    body: ChatSendRequest;
    isClientConnectionAborted: () => boolean;
    organizationId: SafeId<"organization">;
    resume: Parameters<typeof validateMessage>[0]["resume"];
    userId: SafeId<"user">;
    userEmail: string;
    workspaceId: SafeId<"workspace"> | null;
  };
  tools: {
    featureAccessSnapshot: FeatureAccessSnapshot;
    disabledNativeToolSlugs: ChatToolsInput["disabledNativeToolSlugs"];
    registryDispatch: ChatToolsInput["registryDispatch"];
    docxEditRepresentation: NonNullable<
      ChatToolsInput["docxEditRepresentation"]
    >;
    editApplyMode: NonNullable<ChatToolsInput["editApplyMode"]>;
    externalMcpToolsLoader: LazyExternalMcpToolsLoader;
    orgAIConfig: OrgAIConfig | null;
    managedAIResidency: ManagedAIResidency;
    refRegistry: ReturnType<typeof createChatRefRegistry>;
    toolDefectMemo: ReturnType<typeof createChatToolDefectMemo>;
    usageLane: UsageLaneDecision | undefined;
    validationActiveSkillContext: ActiveChatSkillContext | null;
  };
};

/** Validates the provider-facing message and adopts thread/file rollback ownership. */
const prepareValidatedIncomingMessage = async ({
  dependencies: { loadWebSearchProviders, uploadMessageFiles },
  authorization: {
    accessibleWorkspaceIds,
    memberRole,
    pinServerValidatedWorkspaceId,
    requestedContextMatterIds,
    workspaceStatusById,
  },
  lifecycle,
  persistence: { recordAuditEvent, safeDb, scopedDb },
  prerequisites: {
    activeDraftContext,
    activeFileForTools,
    validationThreadState,
  },
  request: {
    body,
    isClientConnectionAborted,
    organizationId,
    resume,
    userId,
    userEmail,
    workspaceId,
  },
  tools: {
    featureAccessSnapshot,
    disabledNativeToolSlugs,
    registryDispatch,
    docxEditRepresentation,
    editApplyMode,
    externalMcpToolsLoader,
    orgAIConfig,
    managedAIResidency,
    refRegistry,
    toolDefectMemo,
    usageLane,
    validationActiveSkillContext,
  },
}: PrepareValidatedIncomingMessageOptions) =>
  await Result.gen(async function* () {
    if (isClientConnectionAborted()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Client disconnected before AI work started",
        }),
      );
    }

    // Resolve the org's web-search providers once (BYOK key first,
    // platform env key as fallback) and reuse for both the validation
    // and streaming tool sets.
    const webSearchProviders = await scopedDb(
      async (tx) => await loadWebSearchProviders(tx, organizationId),
    );

    if (isClientConnectionAborted()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Client disconnected before AI work started",
        }),
      );
    }

    // Agent runs cannot use per-user external connectors. Keep them out of
    // validation too, so an invalid external-tool part is rejected by the
    // tool schema without starting connector discovery. Normal streaming
    // still reuses a validation-triggered load through the memoized loader.
    const externalToolsForValidation =
      body.runMode === CHAT_RUN_MODE.agent
        ? undefined
        : await resolveExternalToolsForValidation(
            body.message,
            externalMcpToolsLoader,
          );

    if (isClientConnectionAborted()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Client disconnected before AI work started",
        }),
      );
    }

    // Tool input schemas don't depend on `accessibleWorkspaceIds`
    // (scope is checked at execute time, not in the schema), so we
    // can validate the incoming message against the broad set and
    // then rebuild the tools with the narrowed `effective` set
    // before streaming. This lets the picker's scope actually
    // govern tool authorization rather than just being persisted.
    // Validation tools include the broadest workspace surface, but
    // still honor thread/org gates for tools whose presence is an
    // explicit user or administrator opt-in.
    const validationTools = getChatValidationTools({
      featureAccessSnapshot,
      organizationId,
      memberRole,
      orgAIConfig,
      managedAIResidency,
      pinServerValidatedWorkspaceId,
      requestWorkspaceId: workspaceId,
      refRegistry,
      toolDefectMemo,
      safeDb,
      scopedDb,
      threadId: body.threadId,
      workspaceId,
      userId,
      userEmail,
      pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
      // Schema validation runs against the user's full accessible
      // set; per-tool scope checks happen at execute time below.
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds,
      }),
      activeFile: activeFileForTools,
      // Validation admits persisted browser calls from any client; the
      // streaming set below registers the tool only when this request's
      // client reports a live extension.
      browserClient: {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      },
      editApplyMode,
      docxEditRepresentation,
      webSearchEnabled: validationThreadState.webSearchEnabled,
      webSearchProviders,
      externalTools: externalToolsForValidation,
      disabledNativeToolSlugs,
      registryDispatch,
      activeSkillContext: validationActiveSkillContext,
      recordAuditEvent,
      resolveMemorySourceWorkspaceIds: () =>
        resolveMemorySourceWorkspaceIds({
          accessibleWorkspaceIds: new Set(accessibleWorkspaceIds),
          contextMatterIds: [],
          dataWorkspaceIds: [],
          registeredWorkspaceIds: refRegistry.getRegisteredWorkspaceIds(),
          workspaceId,
        }),
      workspaceStatusById,
    });

    const validatedMessageResult = await validateMessage({
      message: body.message,
      persistedMessage: validationThreadState.persistedMessage,
      resume,
      safeDb,
      threadId: body.threadId,
      tools: validationTools,
      userId,
    });
    if (Result.isError(validatedMessageResult)) {
      // The wrapping try/finally closes `externalMcpToolsLoader` on this
      // exit path too (a no-op if this message never needed the external
      // tools) — no explicit close needed here.
      return Result.err(validatedMessageResult.error);
    }
    const validatedMessage = validatedMessageResult.value;

    // Captured once and threaded through to generateThreadTitle below: the
    // generator's guard compares the thread's live title against this
    // value to detect any rename (even one whose titleSource column went
    // stale) rather than trusting titleSource alone.
    const initialThreadTitle = extractTitle(validatedMessage.message.parts);

    const thread = yield* Result.await(
      loadThread({
        initialDataWorkspaceIds:
          activeDraftContext === null
            ? []
            : activeDraftContext.originDataWorkspaceIds,
        initialContextMatterIds: requestedContextMatterIds,
        organizationId,
        recordAuditEvent,
        safeDb,
        threadId: body.threadId,
        title: initialThreadTitle,
        userId,
        workspaceId,
      }),
    );
    // Own the thread from creation through the first durable message. The
    // enclosing finally is the sole rollback boundary for every later
    // return, error, or SDK short-circuit before that persistence succeeds.
    lifecycle.adoptThread(thread);

    const activeDraft = body.activeDraft;
    if (activeDraft !== undefined) {
      const hasPersistedContext =
        thread.type === "created"
          ? false
          : yield* Result.await(
              safeDb(async (tx) =>
                hasPersistedGeneratedDocumentActiveDraftContext({
                  generatedDraft: {
                    originChatMessageId: activeDraft.originChatMessageId,
                    originChatThreadId: activeDraft.originChatThreadId,
                    toolCallId: activeDraft.toolCallId,
                  },
                  organizationId,
                  threadId: thread.data.id,
                  tx,
                  userId,
                }),
              ),
            );
      if (
        !canUseChatThreadForGeneratedDocumentDraft({
          hasPersistedContext,
          threadType: thread.type,
        })
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message:
              "Active generated document draft is not bound to this chat",
          }),
        );
      }
    }

    const stampedValidatedMessage = {
      ...validatedMessage,
      message: stampValidatedMessageWithActiveDraftContext({
        activeDraft: body.activeDraft,
        message: validatedMessage.message,
      }),
    };

    // Existing-thread pin changes are durable side effects, so stop before
    // applying them when any earlier validation or thread read observed a
    // client disconnect. Created threads still need their rollback token
    // cleaned up on this exit path.
    if (isClientConnectionAborted()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Client disconnected before AI work started",
        }),
      );
    }

    // The thread's persisted chat-model override wins over the org/instance
    // default, but the dev-only body override still wins over everything
    // (matches `assertDevModelOverride` above). Re-validated here (not just
    // at write time in update-thread-model.ts) so a provider key removal or
    // a catalog bump that drops the model falls back to the org default
    // silently instead of failing the send.
    const {
      modelId: selectedChatModel,
      reasoningEffort: selectedReasoningEffort,
    } = resolveEffectiveChatModelSelection({
      devModelId: body.devModelId,
      threadChatModel: thread.data.chatModel,
      threadReasoningEffort: thread.data.chatReasoningEffort,
      orgAIConfig,
    });

    // Budget routing. Inside the included budget any selection
    // stands. When the pre-flight resolved the reduced-cost lane, an
    // unselected turn is served on the lane's own model. Two cases
    // instead fall through to the pool, which must be able to cover
    // them — the same 402 a pool-only org would see: an explicit
    // model selection, and an agent-mode send (machine work never
    // settles an interactive budget).
    let chatModelOverride = selectedChatModel;
    let chatReasoningEffort = selectedReasoningEffort;
    let turnLane = usageLane ?? { lane: "pool" as const };
    const explicitSelectionNeedsPool =
      turnLane.lane === "fallback" &&
      selectedChatModel !== undefined &&
      selectedChatModel !== turnLane.forcedModelSelection;
    const agentModeNeedsPool =
      body.runMode === "agent" && turnLane.lane !== "pool";
    if (explicitSelectionNeedsPool || agentModeNeedsPool) {
      const poolCheck = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await authorizeHandlerUsage({
              metering: { actionType: "chat" },
              organizationId,
              orgAIConfig,
              workspaceId: null,
              userId,
              safeDb,
            }),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Usage check failed",
              cause,
            }),
        }),
      );
      if (Result.isError(poolCheck)) {
        return Result.err(poolCheck.error);
      }
      turnLane = await poolCheck.value.execute(
        async () => await Promise.resolve({ lane: "pool" as const }),
      );
    } else if (turnLane.lane === "fallback") {
      chatModelOverride = turnLane.forcedModelSelection;
      chatReasoningEffort = undefined;
    }

    // For an existing thread, accept a non-empty body update as
    // "user changed scope, persist it"; an omitted/empty body keeps
    // the stored value so re-sends from cached transports don't
    // silently widen access. Persisted pins are always intersected
    // with the currently accessible set so a revoked workspace
    // cannot be re-authorized through a stale stored pin.
    const storedPinsThisRequest =
      thread.type === "existing" && body.contextMatterIds !== undefined
        ? requestedContextMatterIds
        : thread.data.contextMatterIds;
    const effectiveContextMatterIds = intersectAccessibleWorkspaceIds({
      pinnedIds: storedPinsThisRequest,
      accessibleWorkspaceIds,
    });
    if (
      thread.type === "existing" &&
      !workspaceIdsEqual(
        thread.data.contextMatterIds,
        effectiveContextMatterIds,
      )
    ) {
      yield* Result.await(
        safeDb(async (tx) => {
          await tx
            .update(chatThreads)
            .set({ contextMatterIds: effectiveContextMatterIds })
            .where(eq(chatThreads.id, body.threadId));

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: body.threadId,
            workspaceId,
            changes: {
              contextMatterIds: {
                old: [...thread.data.contextMatterIds],
                new: [...effectiveContextMatterIds],
              },
            },
          });
        }),
      );
    }

    const thirdPartyBoundary = createChatThirdPartyBoundary({
      anonymizationScopeId: workspaceId ?? body.threadId,
      organizationId,
      scopedDb,
      sendMode: body.sendMode,
      threadRestorations: storedRestorationsOf(thread.data.messages),
      workspaceId: workspaceId ?? undefined,
    });

    if (isClientConnectionAborted()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Client disconnected before AI work started",
        }),
      );
    }

    const uploadResult = await uploadMessageFiles({
      message: stampedValidatedMessage.message,
      recordAuditEvent,
      safeDb,
      threadId: thread.data.id,
      threadState: thread,
      userId,
    });
    if (Result.isError(uploadResult)) {
      // The upload helper already cleans a partial upload (and a newly
      // created thread) before returning an error.
      lifecycle.releaseSideEffects();
      return Result.err(uploadResult.error);
    }
    lifecycle.trackUploadedFiles(uploadResult.value.uploadedFiles);

    return Result.ok({
      chatModelOverride,
      chatReasoningEffort,
      effectiveContextMatterIds,
      initialThreadTitle,
      thirdPartyBoundary,
      thread,
      turnLane,
      uploadedMessage: uploadResult.value.message,
      webSearchProviders,
    });
  });

type AssembleTurnSystemPromptOptions = {
  chatContext: {
    systemSafe: ChatSafePromptLayers;
    systemUntrusted: ChatUntrustedPromptSuffix;
  };
  externalMcpTools: LoadedExternalMcpTools | undefined;
  requestedSkillsPrompt: string;
  sendMode: ChatSendMode;
};

// The "safe" half is whatever the prompt builder declared safe. The
// anonymized-mode hint is a fixed assembler-owned addition, so callers cannot
// brand arbitrary strings as safe. The external MCP catalog is
// organization/user-configured text and requested skill bodies are
// user-authored, so both ride with the dynamic suffix and cross the boundary
// in anonymized mode.
const assembleTurnSystemPrompt = ({
  chatContext,
  externalMcpTools,
  requestedSkillsPrompt,
  sendMode,
}: AssembleTurnSystemPromptOptions) => ({
  systemSafe:
    sendMode === CHAT_SEND_MODE.anonymized
      ? appendAnonymizedModeHintToChatSafePrompt(chatContext.systemSafe)
      : chatContext.systemSafe,
  systemUntrusted: extendChatUntrustedPromptSuffix(
    chatContext.systemUntrusted,
    [
      buildExternalMcpSystemHint(
        externalMcpTools === undefined ? [] : externalMcpTools.connectors,
      ),
      requestedSkillsPrompt,
    ].map(chatVolatilePromptSection),
  ),
});

export type SendMessageDependencies = {
  startAdmission?: typeof startExecutionAdmission;
  compactMessagesForContext: typeof compactMessagesForContext;
  createRefRegistry: typeof createChatRefRegistry;
  indexThread: typeof upsertChatThreadSearchDocument;
  loadExternalMcpTools: typeof loadExternalMcpToolsForUser;
  loadWebSearchProviders: typeof loadWebSearchProvidersForOrg;
  /**
   * Reads the caller's membership when an approved write tool runs. Defaults
   * to the credential-boundary read; tests bind it to their own database.
   */
  resolveCurrentMembership?: typeof resolveCredentialMemberAuthorization;
  rollbackSideEffects: typeof rollbackUnpersistedChatSideEffects;
  streamResponse: typeof streamChat;
  uploadMessageFiles: typeof uploadMessageFilesWithRollback;
};

const SEND_MESSAGE_DEPENDENCIES: SendMessageDependencies = {
  compactMessagesForContext,
  createRefRegistry: createChatRefRegistry,
  indexThread: upsertChatThreadSearchDocument,
  loadExternalMcpTools: loadExternalMcpToolsForUser,
  loadWebSearchProviders: loadWebSearchProvidersForOrg,
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChat,
  uploadMessageFiles: uploadMessageFilesWithRollback,
};

/**
 * The thread's names, read by a request that owns the thread's turn; a read
 * that fails fails the turn.
 */
const readOwnedTurnThreadNames = async ({
  lifecycle,
  safeDb,
  threadId,
}: {
  lifecycle: ChatSendLifecycle;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
}): Promise<Result<ChatThreadNamesRead, SafeDbError>> => {
  const read = await safeDb(
    async (tx) => await readChatThreadNames({ threadId, tx }),
  );
  if (Result.isError(read)) {
    await lifecycle.failCurrentTurn("persistence", true);
  }
  return read;
};

const currentMembershipReader = (
  dependencies: SendMessageDependencies,
): typeof resolveCredentialMemberAuthorization =>
  dependencies.resolveCurrentMembership ?? resolveCredentialMemberAuthorization;

export const createSendMessage = (
  dependencies: SendMessageDependencies = SEND_MESSAGE_DEPENDENCIES,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      body: transportBody,
      createAuditRecorder,
      getAccessibleWorkspaces,
      getWorkspaceAccess,
      memberRole,
      orgAIConfig,
      managedAIResidency,
      orgAIConfigStatus,
      promptCachingEnabled,
      pinServerValidatedWorkspaceId,
      recordAuditEvent,
      request,
      safeDb,
      scopedDb,
      session,
      usageLane,
      user,
    }) {
      const body = transportBody.forwardedProps;
      const parentRunId = "parentRunId" in body ? body.parentRunId : undefined;
      const resume = "resume" in body ? body.resume : undefined;
      const transportParentRunId =
        "parentRunId" in transportBody ? transportBody.parentRunId : undefined;
      const transportResume =
        "resume" in transportBody ? transportBody.resume : undefined;
      const isClientConnectionAborted = () => request.signal.aborted;

      if (isClientConnectionAborted()) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      yield* requireTanStackAIAvailableForRole({
        dataClass: "customer",
        configStatus: orgAIConfigStatus,
        orgConfig: orgAIConfig,
        role: "chat",
      });

      const hasEnvelopeCorrelationMismatch = (): boolean =>
        transportBody.threadId !== body.threadId ||
        transportBody.runId !== body.runId ||
        transportParentRunId !== parentRunId ||
        !deepEquals(transportResume, resume) ||
        !deepEquals(transportBody.data, body) ||
        !transportBody.messages.some(
          (message) =>
            message.id === body.message.id &&
            message.role === body.message.role,
        );
      if (hasEnvelopeCorrelationMismatch()) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "AG-UI envelope correlation does not match forwarded input",
          }),
        );
      }

      yield* assertDevModelOverride(body.devModelId, orgAIConfig);
      if (parentRunId === body.runId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "AG-UI child run must differ from its parent run",
          }),
        );
      }
      if (
        resume !== undefined &&
        new Set(resume.map(({ interruptId }) => interruptId)).size !==
          resume.length
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "AG-UI interrupt resume contains duplicate ids",
          }),
        );
      }
      const externalMcpNullUnionStrategy = "json-schema";

      const accessibleWorkspaces = yield* Result.await(
        Result.tryPromise(async () => await getAccessibleWorkspaces()),
      );
      const accessibleWorkspaceIds = usableWorkspaceIds(accessibleWorkspaces);
      // Real per-workspace statuses for the projected write tools' MCP context.
      // The usable ID set includes archived workspaces, so the write handlers'
      // `ensureActiveWorkspace` gate must see the true status (not a default) to
      // keep archived matters read-only.
      const workspaceStatusById = new Map<
        string,
        AccessibleWorkspace["status"]
      >(
        accessibleWorkspaces.map((workspace) => [
          workspace.id,
          workspace.status,
        ]),
      );
      const scope = yield* resolveChatScope({
        getWorkspaceAccess,
        workspaceId: body.workspaceId,
      });

      const workspaceId =
        scope.scope === "workspace" ? scope.workspaceId : null;
      const registryDispatchResult = Result.tryPromise({
        try: async () =>
          await getOrganizationRegistryDispatch({
            organizationId: session.activeOrganizationId,
            scopedDb,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to load business registry availability",
            cause,
          }),
      });
      const orgSettingsForChat = yield* Result.await(
        safeDb((tx) =>
          tx.query.organizationSettings.findFirst({
            where: {
              organizationId: { eq: session.activeOrganizationId },
            },
            columns: {
              practiceJurisdictions: true,
              nativeToolOverrides: true,
            },
          }),
        ),
      );
      const disabledNativeToolSlugs = getDisabledNativeToolSlugs({
        practiceJurisdictions: normalizeOptionalArray(
          orgSettingsForChat?.practiceJurisdictions,
        ),
        nativeToolOverrides: orgSettingsForChat?.nativeToolOverrides ?? {},
      });
      const registryDispatch = yield* Result.await(registryDispatchResult);

      // The body's contextMatterIds is the AI's "draw-from" set —
      // distinct from the chat's own scope (workspaceId/global). It
      // may include the chat's matter plus any others the user wants
      // in scope, validated against the user's accessible matters.
      // Empty (or omitted) means "no matters pinned" — the AI is
      // expected to discover relevant matters via the readonly
      // Stella API instead of being preloaded with thousands of IDs.
      const requestedContextMatterIds = normalizeOptionalArray(
        body.contextMatterIds,
      );
      const accessibleSet = new Set<string>(accessibleWorkspaceIds);
      if (!requestedContextMatterIds.every((id) => accessibleSet.has(id))) {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "contextMatterIds includes inaccessible matter",
          }),
        );
      }

      // Records tool calls that failed with a server defect so every toolset
      // built this turn refuses to re-execute the identical call (see
      // `ChatToolDefectMemo`).
      const toolDefectMemo = createChatToolDefectMemo();
      // `hasActiveDocxFileClient` is narrower than the combined
      // `suggest_changes` gate: only the file overlay
      // (`file-chat-overlay.tsx`) mounts the auto-run watcher that resolves
      // the folio-agents `read_document` / `find_text` tools via
      // `addToolResult`. Template Studio has no such watcher, so a tool call
      // there would hang the session until reload. `docxSuggestionSurface`
      // picks which client executor resolves `suggest_changes`, hence which
      // per-surface schema the model sees. Computed once and reused for tool
      // registration (validation + streaming), the matching prompt guidance
      // below, and, from the same helper, the composer's skill-availability
      // check.
      const {
        docxSuggestionSurface,
        hasActiveDocxEditClient,
        hasActiveDocxFileClient,
      } = resolveChatDocumentClients({
        activeFileSupportsDocxEdits:
          body.activeFile?.supportsDocxEdits === true,
        hasActiveDraft: body.activeDraft !== undefined,
        hasActiveTemplate: body.activeTemplate !== undefined,
      });
      // Per-turn DOCX-edit review-mode setting: which of the two mutually
      // exclusive `suggest_changes` variants (client-executed queue for
      // manual, server-executed apply for auto) `getChatTools` registers,
      // and (for auto) which redline representation it applies with.
      // Resolved once and reused for both the validation and streaming tool
      // sets below, matching every other per-turn setting on this path. An
      // approval response on `suggest_changes` pins the turn to auto: only
      // the apply variant requests approval, and the composer selection may
      // have changed since the call was issued.
      const editApplyMode = hasSuggestChangesApprovalResponse(
        body.message.parts,
      )
        ? CHAT_EDIT_APPLY_MODE.auto
        : (body.editApplyMode ?? DEFAULT_CHAT_EDIT_APPLY_MODE);
      const docxEditRepresentation =
        body.docxEditRepresentation ?? DEFAULT_DOCX_EDIT_REPRESENTATION;
      const activeFileEntity =
        body.activeFile?.supportsDocxEdits === true && workspaceId !== null
          ? yield* Result.await(
              safeDb((tx) =>
                tx.query.entities.findFirst({
                  where: {
                    id: { eq: body.activeFile?.entityId },
                    workspaceId: { eq: workspaceId },
                  },
                  columns: { currentVersionId: true },
                }),
              ),
            )
          : undefined;
      // Server-authoritative version binding for approval-gated automatic DOCX
      // edits. The model must echo this id in the tool input; a later approval
      // request rebuilds the schema from the then-current version, so an old
      // pending call fails validation instead of applying to a newer document.
      const activeFileForTools =
        body.activeFile === undefined
          ? undefined
          : {
              ...body.activeFile,
              ...(activeFileEntity?.currentVersionId === null ||
              activeFileEntity?.currentVersionId === undefined
                ? {}
                : { currentVersionId: activeFileEntity.currentVersionId }),
            };
      const validationThreadState = yield* Result.await(
        readThreadValidationState({
          messageId: body.message.id,
          organizationId: session.activeOrganizationId,
          safeDb,
          threadId: body.threadId,
          userId: user.id,
          workspaceId,
        }),
      );
      // Validation only builds tool schemas and never shows the model a ref;
      // the registry that does is built once this request owns the turn.
      const validationRefRegistry = createChatRefRegistry(
        validationThreadState.threadNames.refBindings,
        validationThreadState.threadNames.retiredRefs,
      );
      const activeDraftContext = yield* Result.await(
        validateActiveDraftContext({
          activeDraft: body.activeDraft,
          organizationId: session.activeOrganizationId,
          safeDb,
          userId: user.id,
        }),
      );
      const validationActiveSkillContext = yield* Result.await(
        resolveActiveChatSkillContext({
          activeSkill: body.activeSkill,
          memberRole,
          organizationId: session.activeOrganizationId,
          safeDb,
          userId: user.id,
        }),
      );
      // Lazy and memoized: connector discovery only runs once some caller
      // actually needs the tools (validation only needs them when
      // `messageNeedsExternalMcpValidation` is true; the streaming pass
      // always needs them), and at most once per send no matter how many
      // callers ask — `createLazyExternalMcpToolsLoader` caches the first
      // call's promise, so a validation-triggered load is reused by the
      // streaming pass instead of running discovery twice.
      // The lifecycle owner tracks whether closing loaded connectors passed to
      // the streaming response, so every earlier exit still closes them once.
      const externalMcpToolsLoader = createLazyExternalMcpToolsLoader(
        async () =>
          await dependencies.loadExternalMcpTools({
            nullUnionStrategy: externalMcpNullUnionStrategy,
            organizationId: session.activeOrganizationId,
            permit: grantThirdPartyOutboundPermit(),
            safeDb,
            userId: user.id,
          }),
      );
      const lifecycle = new ChatSendLifecycle({
        startAdmission: dependencies.startAdmission ?? startExecutionAdmission,
        indexThread: dependencies.indexThread,
        externalMcpToolsLoader,
        mode: CHAT_TURN_BOUNDARY_MODE[body.sendMode],
        recordAuditEvent,
        safeDb,
        scopedDb,
        threadId: body.threadId,
        userId: user.id,
        workspaceId,
        rollbackSideEffects: dependencies.rollbackSideEffects,
      });

      // The try/finally starts immediately after the loader is constructed
      // (rather than just around the streaming pass) so that a throw from
      // any of the awaited steps below — web-search provider load,
      // tool-set construction, message validation — still closes
      // `externalMcpToolsLoader` (a no-op if nothing was ever loaded)
      // instead of leaking MCP clients. The streaming pass takes over connector
      // ownership once it starts consuming the clients; until then this
      // `finally` is the sole owner. `Result.gen`'s `yield*` short-circuit resumes the
      // generator via `.return()`, which unwinds this `finally` like a normal
      // early `return` would.
      try {
        const featureAccessSnapshot = yield* Result.await(
          loadFeatureAccessSnapshot({
            safeDb,
            organizationId: session.activeOrganizationId,
            userId: user.id,
          }),
        );
        const preparedIncomingMessageResult =
          await prepareValidatedIncomingMessage({
            dependencies: {
              loadWebSearchProviders: dependencies.loadWebSearchProviders,
              uploadMessageFiles: dependencies.uploadMessageFiles,
            },
            authorization: {
              accessibleWorkspaceIds,
              memberRole,
              pinServerValidatedWorkspaceId,
              requestedContextMatterIds,
              workspaceStatusById,
            },
            lifecycle,
            persistence: { recordAuditEvent, safeDb, scopedDb },
            prerequisites: {
              activeDraftContext,
              activeFileForTools,
              validationThreadState,
            },
            request: {
              body,
              isClientConnectionAborted,
              organizationId: session.activeOrganizationId,
              resume,
              userId: user.id,
              userEmail: user.email,
              workspaceId,
            },
            tools: {
              featureAccessSnapshot,
              disabledNativeToolSlugs,
              registryDispatch,
              docxEditRepresentation,
              editApplyMode,
              externalMcpToolsLoader,
              orgAIConfig,
              managedAIResidency,
              refRegistry: validationRefRegistry,
              toolDefectMemo,
              usageLane,
              validationActiveSkillContext,
            },
          });
        if (Result.isError(preparedIncomingMessageResult)) {
          return Result.err(preparedIncomingMessageResult.error);
        }
        const {
          chatModelOverride,
          chatReasoningEffort,
          effectiveContextMatterIds,
          initialThreadTitle,
          thirdPartyBoundary,
          thread,
          turnLane,
          uploadedMessage,
          webSearchProviders,
        } = preparedIncomingMessageResult.value;

        const modelAdmission = yield* Result.await(
          lifecycle.admitExecution({
            organizationId: session.activeOrganizationId,
            checkpoint:
              body.message.role === "assistant" &&
              validationThreadState.persistedMessage !== null
                ? toPersistableChatMessage(
                    chatMessageFromPersisted({
                      content: validationThreadState.persistedMessage.content,
                      id: body.message.id,
                      role: validationThreadState.persistedMessage.role,
                    }),
                  )
                : undefined,
          }),
        );
        yield* Result.await(lifecycle.checkAdmission());

        const acceptedTurnResult = await acceptIncomingTurn({
          managedAIResidency,
          accessibleSet,
          accessibleWorkspaceIds,
          body,
          effectiveContextMatterIds,
          lifecycle,
          organizationId: session.activeOrganizationId,
          recordAuditEvent,
          safeDb,
          thread,
          uploadedMessage,
          userId: user.id,
          validationThreadState,
          workspaceId,
          indexThread: dependencies.indexThread,
        });
        if (Result.isError(acceptedTurnResult)) {
          return Result.err(acceptedTurnResult.error);
        }
        const {
          dataScopeAfterIncomingMessage,
          deleteMessageIdsBeforeLatest,
          latestMessagePlan,
          owningAssistantMessage,
          parsedMessage,
          replayTargetMessageId,
          rewrittenOnAcceptance,
          sandboxRun,
          toolWorkspaceIds,
          turnExecution,
        } = acceptedTurnResult.value;

        const runIdTaken = yield* Result.await(
          isChatTurnRunIdTaken({
            execution: turnExecution,
            runId: body.runId,
            safeDb,
          }),
        );
        if (runIdTaken) {
          await lifecycle.failCurrentTurn("internal", false);
          return Result.err(
            new HandlerError({
              status: 409,
              message: "The run id already names another chat turn",
            }),
          );
        }

        yield* Result.await(
          prepareDispatch({
            phase: "bind",
            execution: turnExecution,
            isClientConnectionAborted,
            lifecycle,
            runId: body.runId,
            safeDb,
          }),
        );
        const phaseAdmission = await lifecycle.reserveExecutionPeriod(
          body.runId,
        );
        if (Result.isError(phaseAdmission)) {
          yield* Result.await(
            lifecycle.refuseCurrentTurn(phaseAdmission.error),
          );
          return Result.err(phaseAdmission.error);
        }

        // Refs live as long as the thread, not the request: an interactive
        // answer is a new request, and every ref its history shows the model
        // must keep its target. Read now that this request owns the turn:
        // a request that settled while this one prepared has stored its
        // names, and none can settle until this one does.
        const threadNames = yield* Result.await(
          readOwnedTurnThreadNames({
            lifecycle,
            safeDb,
            threadId: body.threadId,
          }),
        );
        const refRegistry = dependencies.createRefRegistry(
          threadNames.refBindings,
          threadNames.retiredRefs,
        );

        // The incoming message is durable now, so a disconnect must not run the
        // pre-persistence rollback (which would delete files referenced by that
        // message). It should still stop before connector discovery and any
        // metered provider work.
        if (isClientConnectionAborted()) {
          yield* Result.await(lifecycle.interruptCurrentTurn());
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Client disconnected before stream started",
            }),
          );
        }

        const engineHistory = settleHistoryForRun({
          messages: latestMessagePlan.messages,
          resumedMessageId: owningAssistantMessage?.id,
        });
        const messagesForContextInput = await selectMessagesForContextInput({
          messages: engineHistory,
          safeDb,
          skipCheckpoint: replayTargetMessageId !== undefined,
          threadId: body.threadId,
        });

        // Compaction can issue a metered provider request. The turn was claimed
        // above, so a concurrent send is rejected before either request starts
        // this work. Its terminal state remains explicit on every preflight exit.
        const createMeteredAIAbortSignal = () => {
          const deadline = AbortSignal.timeout(
            CHAT_METERED_PROVIDER_TIMEOUT_MS,
          );
          return lifecycle.admissionSignal === undefined
            ? deadline
            : AbortSignal.any([deadline, lifecycle.admissionSignal]);
        };
        if (isClientConnectionAborted()) {
          yield* Result.await(lifecycle.interruptCurrentTurn());
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Client disconnected before AI work started",
            }),
          );
        }

        const messagesForContextResult =
          await dependencies.compactMessagesForContext({
            abortSignal: createMeteredAIAbortSignal(),
            admission: modelAdmission,
            boundary: thirdPartyBoundary,
            chatModelOverride,
            messages: messagesForContextInput,
            organizationId: session.activeOrganizationId,
            orgAIConfig,
            managedAIResidency,
            reasoningEffort: chatReasoningEffort,
            safeDb,
            tenantWorkspaceIds: accessibleWorkspaceIds,
            threadId: body.threadId,
            usageLane: turnLane.lane,
            userId: user.id,
            workspaceId,
          });
        if (Result.isError(messagesForContextResult)) {
          await lifecycle.failCurrentTurn("provider-error", true);
          return Result.err(messagesForContextResult.error);
        }

        if (isClientConnectionAborted()) {
          yield* Result.await(lifecycle.interruptCurrentTurn());
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Client disconnected before AI work started",
            }),
          );
        }

        const registeredDocxEditMode = resolveRegisteredDocxEditMode({
          activeFile: activeFileForTools,
          editApplyMode,
          hasActiveDocxEditClient,
          memberRole,
          recordAuditEventAvailable: true,
          requestWorkspaceId: workspaceId,
          toolWorkspaceIds,
          workspaceStatusById,
        });
        // Reads the assistant makes without an approval, such as a skill
        // loaded by `load-skill`.
        const recordReadAuditEvent = createAuditRecorder({
          execution: {
            performer: {
              type: "agent",
              id: "stella-assistant",
              name: "Stella AI",
            },
            trigger: {
              type: "user_dispatch",
              userId: user.id,
              source: "chat",
              sourceId: body.threadId,
            },
            runId: parsedMessage.message.id,
          },
        });
        // Every input the turn's tool set is built from except the skill
        // catalog and connector tools, which are known only later. Skill
        // availability is decided over the same inputs before the catalog
        // reaches the prompt, so an offered skill always has its tools.
        const visualOrigin = createTurnVisualOrigin({
          incomingMessage: body.message,
          persistedMessage: validationThreadState.persistedMessage,
        });
        const visualTools = {
          origin: visualOrigin,
          preview: async (document: string) =>
            previewVisual({
              document,
              functionArn: env.VISUAL_PREVIEW_FUNCTION_NAME,
            }),
          store: createVisualStore({
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            userId: user.id,
            workspaceId,
          }),
        };
        const chatToolContext = {
          visualTools,
          featureAccessSnapshot,
          createAIAbortSignal: createMeteredAIAbortSignal,
          organizationId: session.activeOrganizationId,
          memberRole,
          orgAIConfig,
          managedAIResidency,
          promptCachingEnabled,
          usageLane: turnLane.lane,
          pinServerValidatedWorkspaceId,
          requestWorkspaceId: workspaceId,
          refRegistry,
          resolveCurrentMembership: currentMembershipReader(dependencies),
          toolDefectMemo,
          safeDb,
          scopedDb,
          threadId: body.threadId,
          workspaceId,
          thirdPartyBoundary,
          excludedChatHistoryMessageIds: deleteMessageIdsBeforeLatest,
          pastChatScope: resolvePastChatScope({
            threadWorkspaceId: workspaceId,
            contextMatterIds: effectiveContextMatterIds,
          }),
          userId: user.id,
          userEmail: user.email,
          toolWorkspaceIds,
          activeFile: activeFileForTools,
          hasActiveDocxEditClient,
          hasActiveDocxFileClient,
          docxSuggestionSurface,
          browserClient: resolveBrowserClientCapability(body.browserClient),
          editApplyMode,
          docxEditRepresentation,
          webSearchEnabled: thread.data.webSearchEnabled,
          webSearchProviders,
          disabledNativeToolSlugs,
          registryDispatch,
          recordAuditEvent: createAuditRecorder({
            execution: {
              // Every tool that receives this recorder is classified as a
              // mutation and executes only after the current user approves it.
              approval: {
                status: "approved",
                userId: user.id,
              },
              performer: {
                type: "agent",
                id: "stella-assistant",
                name: "Stella AI",
              },
              trigger: {
                type: "user_dispatch",
                userId: user.id,
                source: "chat",
                sourceId: body.threadId,
              },
              runId: parsedMessage.message.id,
            },
            ...(workspaceId === null ? {} : { workspaceId }),
          }),
          recordReadAuditEvent,
          resolveMemorySourceWorkspaceIds: () =>
            resolveMemorySourceWorkspaceIds({
              accessibleWorkspaceIds: accessibleSet,
              contextMatterIds: effectiveContextMatterIds,
              dataWorkspaceIds: dataScopeAfterIncomingMessage,
              registeredWorkspaceIds: refRegistry.getRegisteredWorkspaceIds(),
              workspaceId,
            }),
          workspaceStatusById,
        } satisfies ChatSkillToolContext;
        let skillToolNames: ReadonlySet<string> | undefined;
        const offeredToolNamesForSkills = () => {
          skillToolNames ??= chatToolNamesForSkills({
            ...chatToolContext,
            toolScope: body.toolScope,
          });
          return skillToolNames;
        };
        const chatContextResult = await prepareChatContext({
          featureAccessSnapshot,
          activeDecision: body.activeDecision,
          activeDraft: body.activeDraft,
          activeExternal: body.activeExternal,
          activeFile: body.activeFile,
          activeSkillContext: validationActiveSkillContext,
          activeStatute: body.activeStatute,
          activeTemplate: body.activeTemplate,
          contextMatterIds: effectiveContextMatterIds,
          hasReachableMatter: toolWorkspaceIds.length > 0,
          latestMentions: parsedMessage.mentions,
          latestUserMessageId: parsedMessage.message.id,
          messageWindow: messagesForContextResult.value,
          organizationId: session.activeOrganizationId,
          offeredToolNamesForSkills,
          safeDb,
          sendMode: body.sendMode,
          toolAvailability: {
            docxEditMode: registeredDocxEditMode,
            templateAuthoring: areTemplateAuthoringToolsRegistered(memberRole),
            webResearch: areWebResearchToolsRegistered({
              webSearchEnabled: thread.data.webSearchEnabled,
              webSearchProviders,
              disabledNativeToolSlugs,
            }),
            folioAgentDocTools: hasActiveDocxFileClient,
            subagents: areSubagentToolsAvailableForTurn({
              activeSkillContext: validationActiveSkillContext,
              toolScope: body.toolScope,
            }),
          },
          userContext: body.userContext,
          userId: user.id,
          workspaceId,
          refRegistry,
        });
        if (Result.isError(chatContextResult)) {
          await lifecycle.failCurrentTurn(
            "internal",
            !(chatContextResult.error instanceof HandlerError) ||
              chatContextResult.error.status >= 500,
          );
          return Result.err(chatContextResult.error);
        }
        const chatContext = chatContextResult.value;

        if (isClientConnectionAborted()) {
          yield* Result.await(lifecycle.interruptCurrentTurn());
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Client disconnected before AI work started",
            }),
          );
        }

        // Normal streaming needs external MCP tools. Agent runs reach tools only
        // through their workspace-scoped Stella MCP binding, so loading per-user
        // external connectors here would create unused clients.
        const externalMcpToolsResult = shouldLoadExternalMcpToolsForStreaming(
          body.runMode,
        )
          ? await Result.tryPromise({
              try: async () =>
                await externalMcpToolsLoader.getExternalMcpTools(),
              catch: (cause) =>
                new HandlerError({
                  status: 500,
                  message: "Failed to discover chat connectors",
                  cause,
                }),
            })
          : Result.ok(undefined);
        if (Result.isError(externalMcpToolsResult)) {
          await lifecycle.failCurrentTurn("connector-discovery", true);
          return Result.err(externalMcpToolsResult.error);
        }
        const externalMcpTools = externalMcpToolsResult.value;

        // Streaming tools mirror the surface the user is on: only the
        // DOCX file-overlay client knows how to satisfy
        // suggest_changes (it queues into the review store and
        // sends the output back via TanStack ChatClient.addToolResult).
        // PDF/file overlays
        // still send active-file context, but they must not expose the
        // DOCX edit tool or the model can chase an impossible path. The
        // folio-agents `read_document`/`find_text` tools are narrower
        // still — `hasActiveDocxFileClient` only, since Template Studio
        // mounts no watcher to resolve them.
        const chatTools = getChatTools({
          ...chatToolContext,
          modelAdmission,
          externalTools: externalMcpTools?.tools ?? {},
          skillMetadata: chatContext.skillMetadata,
          activeSkillContext: chatContext.activeSkillContext,
        });
        // A named scope narrows the streaming turn to its server-defined
        // allowlist (validation above stays broad so persisted tool parts
        // keep validating). The scope name is schema-validated; unknown
        // names never reach this point.
        const toolReadScope = createToolReadScopeRecorder({
          accessibleWorkspaceIds: accessibleSet,
          persist: async (newWorkspaceIds) =>
            await expandThreadDataScope({
              newWorkspaceIds,
              recordAuditEvent,
              safeDb,
              threadId: body.threadId,
              threadWorkspaceId: workspaceId,
            }),
          refRegistry,
        });
        const streamingTools = recordToolReadScope({
          recorder: toolReadScope,
          tools:
            body.toolScope === undefined
              ? chatTools
              : restrictChatToolsToScope(chatTools, body.toolScope),
        });

        const requestedSkillsPrompt = await loadRequestedSkillsPrompt({
          activeSkillContext: chatContext.activeSkillContext,
          catalog: chatContext.skillMetadata,
          messages: chatContext.hydratedMessages,
          organizationId: session.activeOrganizationId,
          recordAuditEvent: recordReadAuditEvent,
          safeDb,
          userId: user.id,
        });
        if (Result.isError(requestedSkillsPrompt)) {
          await lifecycle.failCurrentTurn("internal", true);
          return Result.err(requestedSkillsPrompt.error);
        }
        const storedHistory = await loadStoredHistory({
          historyIds: latestMessagePlan.messages.flatMap(({ id }) =>
            id === owningAssistantMessage?.id
              ? []
              : [brandPersistedChatMessageId(id)],
          ),
          rewrittenOnAcceptance,
          safeDb,
          threadId: body.threadId,
          userId: user.id,
        });
        if (Result.isError(storedHistory)) {
          await lifecycle.failCurrentTurn("internal", true);
          return Result.err(storedHistory.error);
        }
        const { systemSafe, systemUntrusted } = assembleTurnSystemPrompt({
          chatContext,
          externalMcpTools,
          requestedSkillsPrompt: requestedSkillsPrompt.value,
          sendMode: body.sendMode,
        });

        yield* Result.await(lifecycle.checkAdmission());
        yield* Result.await(
          prepareDispatch({
            phase: "dispatch",
            execution: turnExecution,
            isClientConnectionAborted,
            lifecycle,
            runId: body.runId,
            safeDb,
          }),
        );

        yield* Result.await(lifecycle.checkAdmission());

        const isServerTool = (toolName: string) =>
          registeredChatTool(streamingTools, toolName)?.execute !== undefined;

        // A completed, non-anonymized turn marks compaction due and titles a
        // new thread; neither affects whether the turn itself settled.
        const runCompletedTurnFollowUps = async (
          run: ChatTurnRun,
          {
            messagesAfterAssistantPersist,
            resolvedResponseMessage,
          }: CompletedTurnFollowUps,
        ) => {
          if (
            messagesAfterAssistantPersist !== null &&
            body.sendMode !== CHAT_SEND_MODE.anonymized
          ) {
            await markChatCompactionDue({
              chatModelOverride,
              messages: messagesAfterAssistantPersist,
              organizationId: session.activeOrganizationId,
              orgAIConfig,
              reasoningEffort: chatReasoningEffort,
              safeDb,
              threadId: body.threadId,
            });
          }

          if (
            thread.type === "created" &&
            body.sendMode !== CHAT_SEND_MODE.anonymized
          ) {
            const title = async () =>
              await generateThreadTitle({
                indexThread: dependencies.indexThread,
                initialTitle: initialThreadTitle,
                messages: [parsedMessage.message, resolvedResponseMessage],
                organizationId: session.activeOrganizationId,
                orgAIConfig,
                managedAIResidency,
                promptCachingEnabled,
                recordAuditEvent,
                safeDb,
                threadId: body.threadId,
                threadWorkspaceId: workspaceId,
                userId: user.id,
              });
            detached(
              run.followUpAfterSettlement(title),
              "send-message.generate-thread-title",
            );
          }
        };

        const response = yield* Result.await(
          Result.tryPromise({
            try: async () => {
              // Snapshot what the registry has observed before streaming.
              // Prompt-time pins (`contextMatterIds` → `toMatterRef`) are
              // resolved during prompt construction and are not reads of the
              // turn; tool schemas only offer matter refs, which the registry
              // does not count as observed. Reads observed from here on widen
              // `data_workspace_ids` as each tool returns and again at finish.
              const workspaceIdsBeforeStream = toolReadScope.startTurn();

              // The run owns the turn and the loaded connectors from here.
              // Agent runs load none for streaming, so the send's cleanup
              // closes any validation-only load.
              const run = lifecycle.startRun(externalMcpTools);
              try {
                // The streamed turn's persistence: every expected failure
                // comes back as a `Result` naming the turn row's failure code,
                // and nothing here settles the turn, which is the `onFinish`
                // boundary's job. It returns what the turn row now holds, and
                // for a completed turn what its follow-ups need.
                const persistStreamedAssistantTurn = async ({
                  outcome,
                  responseMessage,
                }: StreamChatFinishEvent): Promise<
                  Result<
                    {
                      followUps: CompletedTurnFollowUps | null;
                      settlement: ChatTurnStoredSettlement;
                    },
                    AssistantTurnFailure
                  >
                > => {
                  const validatedToolParts = validateToolCallParts({
                    allowPartialInput: CUT_SHORT_OUTCOME[outcome.type],
                    message: responseMessage,
                    tools: streamingTools,
                  });
                  if (Result.isError(validatedToolParts)) {
                    // Nothing of this turn can be stored.
                    return Result.err({
                      code: "persistence",
                      error: new HandlerError({
                        status: 500,
                        message: "Generated chat tool parts are invalid",
                        cause: validatedToolParts.error,
                      }),
                    });
                  }
                  const canonicalResponseMessage = toPersistableChatMessage({
                    ...responseMessage,
                    parts: validatedToolParts.value,
                  });
                  const resolved = resolveAssistantMessageRefs({
                    accessibleWorkspaceIds: accessibleSet,
                    isServerTool,
                    messages: [canonicalResponseMessage],
                    opaqueReadWorkspaceIds:
                      body.runMode === CHAT_RUN_MODE.agent
                        ? toolWorkspaceIds
                        : [],
                    refRegistry,
                    workspaceIdsBeforeStream,
                  });
                  const resolvedResponseMessage =
                    resolved.messages.at(0) ??
                    panic("Missing chat response message");
                  const addedThreadNames = {
                    refBindings: resolved.refBindings,
                    toolCallIds: toolCallIdsOf(resolvedResponseMessage.parts),
                  };

                  // Widen the thread's data scope to cover any
                  // workspace-scoped content the assistant just
                  // emitted (source-document parts from search and
                  // workspace tools). Scope, message, and turn settlement are
                  // written in one transaction below.
                  //
                  // If expansion fails (transient DB error, etc.), the whole
                  // transaction fails. Storing workspace-
                  // scoped content in `chat_messages` while the
                  // owning thread's `data_workspace_ids` stays stale
                  // would leave the new content readable after the
                  // user loses access to those workspaces — the same
                  // class of leak this whole change exists to close.
                  //
                  const persistResult = await finalizeAssistantTurn({
                    acceptedSendMode: body.sendMode,
                    threadNames: {
                      added: addedThreadNames,
                      read: threadNames,
                    },
                    dataScopeExpansion: {
                      newWorkspaceIds: resolved.workspaceIds,
                    },
                    existingIds: latestMessagePlan.existingIds,
                    execution: turnExecution,
                    outcome,
                    owningAssistantMessage,
                    recordAuditEvent,
                    responseMessage: resolvedResponseMessage,
                    safeDb,
                    threadId: body.threadId,
                    userId: user.id,
                    workspaceId,
                    indexThread: dependencies.indexThread,
                  });
                  if (
                    Result.isError(persistResult) &&
                    isChatTurnNotOwned(persistResult.error)
                  ) {
                    // Another execution or the reaper settled the turn
                    // first: its outcome stands, and this run has nothing
                    // left to store or count.
                    return Result.ok({
                      followUps: null,
                      settlement: { type: "not-owned" },
                    });
                  }
                  if (Result.isError(persistResult)) {
                    captureError(persistResult.error, {
                      threadId: body.threadId,
                    });
                    return Result.err({
                      code: "persistence",
                      error: new HandlerError({
                        status: 500,
                        message: "Failed to persist assistant turn",
                        cause: persistResult.error,
                      }),
                    });
                  }

                  const { outcome: storedOutcome, persistencePlan } =
                    persistResult.value;
                  const messagesAfterAssistantPersist =
                    applyAssistantPersistencePlan({
                      messages: latestMessagePlan.messages,
                      persistencePlan,
                    });
                  return Result.ok({
                    // A stop that won the race stored `cancelled`, whatever
                    // the run proposed.
                    followUps:
                      storedOutcome.type === "completed"
                        ? {
                            messagesAfterAssistantPersist,
                            resolvedResponseMessage,
                          }
                        : null,
                    settlement: { type: "stored", outcome: storedOutcome },
                  });
                };

                const outcome = await dependencies.streamResponse({
                  modelAdmission,
                  visualOrigin,
                  runId: body.runId,
                  ...(parentRunId === undefined ? {} : { parentRunId }),
                  ...(resume === undefined ? {} : { resume }),
                  messages: chatContext.hydratedMessages,
                  latestMessageId: parsedMessage.message.id,
                  storedHistory: storedHistory.value,
                  threadToolCallIds: threadNames.toolCallIds,
                  ...(owningAssistantMessage === undefined
                    ? {}
                    : { owningAssistantMessageId: owningAssistantMessage.id }),
                  onFinish: async (event) =>
                    await settleStreamedAssistantTurn({
                      persist: async () =>
                        await persistStreamedAssistantTurn(event),
                      run,
                      runFollowUps: async (followUps) =>
                        await runCompletedTurnFollowUps(run, followUps),
                      threadId: body.threadId,
                    }),
                  orgAIConfig,
                  managedAIResidency,
                  organizationId: session.activeOrganizationId,
                  devModelId: chatModelOverride,
                  reasoningEffort: chatReasoningEffort,
                  promptCacheKey: chatContext.promptCacheKey,
                  promptCachingEnabled,
                  runMode: body.runMode,
                  sandboxRun,
                  usageLane: turnLane.lane,
                  resolveAssistantTextRefs:
                    refRegistry.resolveAssistantTextRefs,
                  resolveAssistantToolInputRefs: ({ input, toolName }) =>
                    resolveRegistryToolInputRefs({
                      input,
                      refRegistry,
                      toolName,
                    }),
                  resolveAssistantToolOutputRefs: ({ output, toolName }) =>
                    resolveRegistryToolOutputRefs({
                      output,
                      refRegistry,
                      toolName,
                    }),
                  resolveAssistantValueRefs:
                    refRegistry.resolveAssistantValueRefs,
                  run,
                  safeDb,
                  tenantWorkspaceIds: accessibleWorkspaceIds,
                  thirdPartyBoundary,
                  threadId: body.threadId,
                  tools: streamingTools,
                  externalMcpToolSource: externalMcpTools?.source,
                  systemSafe,
                  systemUntrusted,
                  userId: user.id,
                  workspaceId,
                });

                // streamChat can reject before it creates an SSE stream (for
                // example an anonymization-boundary or attachment-modality
                // refusal). No terminal middleware hook runs in that branch,
                // so settle the claimed turn here instead of leaving it
                // indefinitely running.
                switch (outcome.type) {
                  case "refused":
                    await run.fail(
                      outcome.response.failureCode,
                      outcome.response.retryable,
                    );
                    return outcome.response;
                  case "streaming":
                    return outcome.response;
                  default: {
                    outcome satisfies never;
                    return panic(
                      `Unhandled chat stream outcome: ${String(outcome)}`,
                    );
                  }
                }
              } catch (error) {
                await run.fail("internal", true);
                throw error;
              }
            },
            catch: (cause) =>
              cause instanceof HandlerError
                ? cause
                : new HandlerError({
                    status: 500,
                    message: "Failed to start chat response",
                    cause,
                  }),
          }),
        );

        return Result.ok(response);
      } finally {
        await lifecycle.cleanup();
      }
    },
  );

const sendMessage = createSendMessage();

export default sendMessage;

type ApplyAssistantPersistencePlanProps = {
  messages: PersistableChatMessage[];
  persistencePlan: MessagePersistencePlan;
};

const applyAssistantPersistencePlan = ({
  messages,
  persistencePlan,
}: ApplyAssistantPersistencePlanProps): PersistableChatMessage[] | null => {
  switch (persistencePlan.type) {
    case "none":
      return null;
    case "insert":
      return [...messages, persistencePlan.message];
    case "update":
      return messages.map((message) =>
        message.id === persistencePlan.messageId
          ? persistencePlan.message
          : message,
      );
    case "replace-last-assistant":
      return [
        ...messages.filter(
          (message) => message.id !== persistencePlan.deleteMessageId,
        ),
        persistencePlan.insertMessage,
      ];
    default: {
      persistencePlan satisfies never;
      return panic(`Unhandled persistence plan: ${String(persistencePlan)}`);
    }
  }
};

const messageNeedsExternalMcpValidation = (
  message: ChatSendRequest["message"],
): boolean => {
  if (message.role !== "assistant") {
    return false;
  }

  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(isExternalMcpToolPart);
};

/**
 * Loads external MCP tools (via the memoized `loader`) only when the
 * incoming message needs them for validation; returns `undefined` without
 * ever calling the loader otherwise. Kept as a standalone helper so its
 * branch doesn't add to the handler generator's own cognitive complexity.
 */
const resolveExternalToolsForValidation = async (
  message: ChatSendRequest["message"],
  loader: LazyExternalMcpToolsLoader,
): Promise<LoadedExternalMcpTools["tools"] | undefined> => {
  if (!messageNeedsExternalMcpValidation(message)) {
    return undefined;
  }
  const loaded = await loader.getExternalMcpTools();
  return loaded.tools;
};

export const shouldLoadExternalMcpToolsForStreaming = (
  runMode: ChatSendRequest["runMode"],
): boolean => runMode !== CHAT_RUN_MODE.agent;

type PrepareChatContextProps = {
  featureAccessSnapshot: FeatureAccessSnapshot;
  activeDecision: IncomingActiveDecision | undefined;
  activeDraft: IncomingActiveDraft | undefined;
  activeExternal: IncomingActiveExternal | undefined;
  activeFile: IncomingActiveFile | undefined;
  activeSkillContext: ActiveChatSkillContext | null;
  activeStatute: IncomingActiveStatute | undefined;
  activeTemplate: IncomingActiveTemplate | undefined;
  contextMatterIds: SafeId<"workspace">[];
  hasReachableMatter: boolean;
  latestMentions: readonly ChatMention[];
  latestUserMessageId: string;
  messageWindow: ChatMessage[];
  /** The turn's tool names, for deciding which skills it can offer. */
  offeredToolNamesForSkills: () => ReadonlySet<string>;
  organizationId: SafeId<"organization">;
  refRegistry: ReturnType<typeof createChatRefRegistry>;
  safeDb: SafeDb;
  sendMode: ChatSendMode;
  toolAvailability: ChatToolAvailability;
  userContext: IncomingUserContext | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type PrepareChatContextResult = Result<
  {
    hydratedMessages: ChatMessage[];
    promptCacheKey: string;
    /**
     * Server-built scaffold. Safe to send to the LLM verbatim.
     */
    systemSafe: ChatSafePromptLayers;
    /**
     * Dynamic user-supplied context (active file body, decision
     * text, external source, matter labels). Pass through the
     * boundary in anonymized mode before concatenating with
     * `systemSafe`.
     */
    systemUntrusted: ChatUntrustedPromptSuffix;
    skillMetadata: readonly SkillMetadata[];
    activeSkillContext: ActiveChatSkillContext | null;
  },
  HandlerError<403 | 404 | 422 | 500> | SafeDbError
>;

const prepareChatContext = async ({
  featureAccessSnapshot,
  activeDecision,
  activeDraft,
  activeExternal,
  activeFile,
  activeSkillContext,
  activeStatute,
  activeTemplate,
  contextMatterIds,
  hasReachableMatter,
  latestMentions,
  latestUserMessageId,
  messageWindow,
  offeredToolNamesForSkills,
  organizationId,
  refRegistry,
  safeDb,
  sendMode,
  toolAvailability,
  userContext,
  userId,
  workspaceId,
}: PrepareChatContextProps): Promise<PrepareChatContextResult> =>
  await Result.gen(async function* () {
    const orgSettingsRow = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: { practiceJurisdictions: true },
        }),
      ),
    );
    const practiceJurisdictions = normalizeOptionalArray(
      orgSettingsRow?.practiceJurisdictions,
    );

    const promptAndMessagesResult = await Result.allAsync([
      buildChatSystemPromptParts({
        featureAccessContext: { featureAccessSnapshot, organizationId, userId },
        activeDecision,
        activeDraft,
        activeExternal,
        activeFile,
        activeSkillContext,
        activeStatute,
        activeTemplate,
        contextMatterIds,
        hasReachableMatter,
        offeredToolNamesForSkills,
        organizationId,
        practiceJurisdictions,
        refRegistry,
        safeDb,
        toolAvailability,
        userContext,
        userId,
        workspaceId,
      }),
      hydrateMessages({
        messages: messageWindow,
        safeDb,
        sendMode,
        userId,
      }),
    ]);
    const [systemPrompt, hydratedMessages] =
      yield* promptAndMessagesResult.mapError((error) =>
        ChatError.is(error)
          ? new HandlerError({
              status: 500,
              message: error.message,
              cause: error,
            })
          : error,
      );

    const messagesWithActiveFileFallback = yield* Result.await(
      attachActiveFileFallbackWhenExtractionIsEmpty({
        activeFile,
        hydratedMessages,
        organizationId,
        safeDb,
        sendMode,
        workspaceId,
      }),
    );
    const messagesWithHydratedRefs = hydrateAssistantMessageRefs({
      messages: messagesWithActiveFileFallback,
      refRegistry,
    });
    const messagesWithMentionKinds = yield* Result.await(
      attachVerifiedEntityMentionKinds({
        latestMentions,
        latestUserMessageId,
        messages: messagesWithHydratedRefs,
        refRegistry,
        safeDb,
      }),
    );

    return Result.ok({
      promptCacheKey: buildChatPromptCacheKey(systemPrompt.cacheStablePrefix),
      systemSafe: systemPrompt.safeLayers,
      systemUntrusted: systemPrompt.untrustedSuffix,
      skillMetadata: systemPrompt.skillMetadata,
      activeSkillContext: systemPrompt.activeSkillContext,
      hydratedMessages: messagesWithMentionKinds,
    });
  });

type AttachActiveFileFallbackWhenExtractionIsEmptyProps = {
  activeFile: IncomingActiveFile | undefined;
  hydratedMessages: ChatMessage[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  sendMode: ChatSendMode;
  workspaceId: SafeId<"workspace"> | null;
};

const attachActiveFileFallbackWhenExtractionIsEmpty = async ({
  activeFile,
  hydratedMessages,
  organizationId,
  safeDb,
  sendMode,
  workspaceId,
}: AttachActiveFileFallbackWhenExtractionIsEmptyProps): Promise<
  Result<ChatMessage[], HandlerError<422 | 500> | SafeDbError>
> =>
  await Result.gen(async function* () {
    if (
      sendMode !== CHAT_SEND_MODE.rawOverride ||
      workspaceId === null ||
      activeFile?.fileFieldId === undefined ||
      activeFile.supportsDocxEdits === true
    ) {
      return Result.ok(hydratedMessages);
    }

    const latestUserIndex = hydratedMessages.findLastIndex(
      (message) => message.role === "user",
    );
    if (latestUserIndex === -1) {
      return Result.ok(hydratedMessages);
    }

    const activeFileBinding = yield* Result.await(
      resolveActiveFileModelBinding({
        activeFile,
        fileFieldId: activeFile.fileFieldId,
        safeDb,
        workspaceId,
      }),
    );
    if (
      activeFileBinding === null ||
      activeFileBinding.type === "durable-current"
    ) {
      return Result.ok(hydratedMessages);
    }

    const activeFileFallback = yield* Result.await(
      readActiveFileFallbackForModel({
        organizationId,
        source: activeFileBinding.source,
        sourceVersion: activeFileBinding.version,
        workspaceId,
      }),
    );
    const nextMessages = [...hydratedMessages];
    const latestUserMessage = hydratedMessages.at(latestUserIndex);
    if (!latestUserMessage) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to find user message for context attachment",
        }),
      );
    }
    const fallbackParts: ChatMessage["parts"] = [];
    switch (activeFileFallback.type) {
      case "pdf":
        fallbackParts.push(
          {
            type: "text",
            content: `The exact ${activeFileFallback.sourceVersion} version of the active file "${activeFileFallback.fileName}" is attached directly as a PDF. Use this attachment for the current question instead of entity-level retrieval.`,
          },
          createRawChatFilePart({
            bytes: activeFileFallback.bytes,
            fileName: activeFileFallback.fileName,
            mimeType: PDF_MIME_TYPE,
          }),
        );
        break;
      case "extracted-text":
        fallbackParts.push(
          {
            type: "text",
            content: `The exact ${activeFileFallback.sourceVersion} version of the active file "${activeFileFallback.fileName}" is attached as extracted text. Use this text for the current question instead of entity-level retrieval.${activeFileFallback.truncated ? " The attachment is truncated to the first available window." : ""}`,
          },
          {
            type: "text",
            content: sanitizeForPrompt(
              untrustedText(activeFileFallback.content),
            ),
          },
        );
        break;
      default:
        activeFileFallback satisfies never;
        panic(`Unhandled active file fallback: ${String(activeFileFallback)}`);
    }

    nextMessages[latestUserIndex] = {
      ...latestUserMessage,
      parts: [...latestUserMessage.parts, ...fallbackParts],
    };

    return Result.ok(nextMessages);
  });

type ResolveActiveFileModelBindingProps = {
  activeFile: IncomingActiveFile;
  fileFieldId: SafeId<"field">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

const resolveActiveFileModelBinding = async ({
  activeFile,
  fileFieldId,
  safeDb,
  workspaceId,
}: ResolveActiveFileModelBindingProps): Promise<
  Result<ActiveFileModelBinding | null, SafeDbError>
> =>
  await Result.gen(async function* () {
    const field = yield* Result.await(
      safeDb((tx) =>
        tx.query.fields.findFirst({
          where: {
            id: { eq: fileFieldId },
            workspaceId: { eq: workspaceId },
          },
          columns: { content: true },
          with: {
            entityVersion: {
              columns: { deletedAt: true, id: true },
              with: {
                entity: {
                  columns: { currentVersionId: true, id: true },
                  with: {
                    extractedContent: {
                      columns: {
                        charCount: true,
                        sourceEntityVersionId: true,
                        sourceFieldId: true,
                        sourceFileId: true,
                        sourceSha256Hex: true,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    );
    if (!field) {
      return Result.ok(null);
    }
    if (!field.entityVersion) {
      panic("Active file field is missing its entity version relation");
    }
    if (!field.entityVersion.entity) {
      panic("Active file version is missing its entity relation");
    }
    if (
      field.entityVersion.deletedAt !== null ||
      field.entityVersion.entity.id !== activeFile.entityId ||
      field.content.type !== "file"
    ) {
      return Result.ok(null);
    }

    return Result.ok(
      getActiveFileModelBinding({
        content: field.content,
        currentVersionId: field.entityVersion.entity.currentVersionId,
        extractedContent: field.entityVersion.entity.extractedContent ?? null,
        fieldId: fileFieldId,
        fieldVersionId: field.entityVersion.id,
      }),
    );
  });

type ReadActiveFileFallbackForModelProps = {
  organizationId: SafeId<"organization">;
  source: ActiveFileSourceForModel;
  sourceVersion: "current" | "historical";
  workspaceId: SafeId<"workspace">;
};

type ActiveFileFallbackForModel =
  | {
      type: "pdf";
      bytes: Uint8Array;
      fileName: string;
      sourceVersion: "current" | "historical";
    }
  | {
      type: "extracted-text";
      content: string;
      fileName: string;
      sourceVersion: "current" | "historical";
      truncated: boolean;
    };

const activeFileSizeLimitError = () =>
  new HandlerError({
    status: 422,
    message: `Active file exceeds the ${FILE_SIZE_LIMITS.chatContextFile} chat context limit`,
  });

const readActiveFileFallbackForModel = async ({
  organizationId,
  source,
  sourceVersion,
  workspaceId,
}: ReadActiveFileFallbackForModelProps): Promise<
  Result<ActiveFileFallbackForModel, HandlerError<422 | 500>>
> =>
  await Result.gen(async function* () {
    if (
      source.knownSizeBytes !== null &&
      source.knownSizeBytes > FILE_SIZE_LIMIT_BYTES.chatContextFile
    ) {
      return Result.err(activeFileSizeLimitError());
    }

    const s3Key = createFileKey({
      organizationId,
      workspaceId,
      fileId: source.fileId,
      mimeType: source.mimeType,
    });
    const storedSource = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await readStoredFile({ key: s3Key, mimeType: source.mimeType }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to read active file for AI context",
            cause,
          }),
      }),
    );
    const buffer = storedSource.bytes;
    if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.chatContextFile) {
      return Result.err(activeFileSizeLimitError());
    }

    if (source.type === "extracted-text") {
      const extracted = await extractFileTextResult(storedSource);
      if (Result.isError(extracted)) {
        return Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to extract active file for AI context",
            cause: extracted.error,
          }),
        );
      }
      if (extracted.value === null) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Active file does not contain extractable text",
          }),
        );
      }
      const fallback: ActiveFileFallbackForModel = {
        type: "extracted-text",
        content: extracted.value.slice(0, LIMITS.chatContextFileMaxChars),
        fileName: source.fileName,
        sourceVersion,
        truncated: extracted.value.length > LIMITS.chatContextFileMaxChars,
      };
      return Result.ok(fallback);
    }

    const bytes = new Uint8Array(buffer);
    const fallback: ActiveFileFallbackForModel = {
      type: "pdf",
      bytes,
      fileName: source.fileName,
      sourceVersion,
    };
    return Result.ok(fallback);
  });

type ResolveAssistantMessageRefsProps = {
  accessibleWorkspaceIds: ReadonlySet<string>;
  /** Whether this request's server ran `toolName`, rather than a client. */
  isServerTool: (toolName: string) => boolean;
  messages: PersistableChatMessage[];
  opaqueReadWorkspaceIds: readonly SafeId<"workspace">[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
  workspaceIdsBeforeStream: ReadonlySet<SafeId<"workspace">>;
};

type ResolveAssistantMessageRefsResult = {
  messages: PersistableChatMessage[];
  /** The refs the messages showed the model. */
  refBindings: ChatRefBinding[];
  workspaceIds: SafeId<"workspace">[];
};

const stringifyToolPayload = (value: unknown): unknown => JSON.stringify(value);

const toolResultPayload = ({
  outputsByCallId,
  part,
}: {
  outputsByCallId: ReadonlyMap<string, unknown>;
  part: Extract<ChatPart, { type: "tool-result" }>;
}): unknown => {
  if (outputsByCallId.has(part.toolCallId)) {
    return outputsByCallId.get(part.toolCallId);
  }
  if (part.state === "error" && part.error !== undefined) {
    return { error: part.error };
  }
  return undefined;
};

const synchronizeToolResultContent = (
  parts: readonly ChatPart[],
): ChatPart[] => {
  const outputsByCallId = new Map<string, unknown>();
  for (const part of parts) {
    if (part.type === "tool-call" && part.output !== undefined) {
      outputsByCallId.set(part.id, part.output);
    }
  }

  return parts.map((part) => {
    if (part.type !== "tool-result" || part.state === "streaming") {
      return part;
    }
    const payload = toolResultPayload({ outputsByCallId, part });
    if (Array.isArray(part.content)) {
      if (!deepEquals(part.content, payload)) {
        panic(`Canonical tool result ${part.toolCallId} disagrees with output`);
      }
      return part;
    }
    const content = stringifyToolPayload(payload);
    if (typeof content !== "string") {
      panic(
        `Canonical tool result ${part.toolCallId} has no serializable output`,
      );
    }
    return { ...part, content };
  });
};

type ResolveAssistantPartRefsProps = {
  part: ChatMessage["parts"][number];
  entityContexts: ChatEntityRefContext[];
  unresolvedInputRefs: ChatUnresolvedInputRefContext[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
};

const resolveAssistantPartRefs = ({
  part,
  entityContexts,
  unresolvedInputRefs,
  refRegistry,
}: ResolveAssistantPartRefsProps): ChatMessage["parts"][number] => {
  const withDeclaredToolRefs: unknown =
    part.type === "tool-call"
      ? {
          ...part,
          ...("input" in part
            ? {
                input: resolveRegistryToolInputRefs({
                  input: part.input,
                  onEntityRefResolved: (target) => {
                    entityContexts.push({
                      entity: resourceRef({
                        type: RESOURCE_TYPE.ENTITY,
                        id: target.entityId,
                      }),
                      toolCallId: part.id,
                      workspace: resourceRef({
                        type: RESOURCE_TYPE.WORKSPACE,
                        id: target.workspaceId,
                      }),
                    });
                  },
                  onRefUnresolved: (unresolved) => {
                    unresolvedInputRefs.push({
                      ...unresolved,
                      toolCallId: part.id,
                    });
                  },
                  refRegistry,
                  toolName: part.name,
                }),
              }
            : {}),
          ...("output" in part
            ? {
                output: resolveRegistryToolOutputRefs({
                  output: part.output,
                  refRegistry,
                  toolName: part.name,
                }),
              }
            : {}),
        }
      : part;
  const resolved = refRegistry.resolveAssistantValueRefs(withDeclaredToolRefs);
  if (!isChatPart(resolved)) {
    panic("Resolving assistant refs changed the message part shape");
  }
  return resolved;
};

const resolveAssistantMessageRefs = ({
  accessibleWorkspaceIds,
  isServerTool,
  messages,
  opaqueReadWorkspaceIds,
  refRegistry,
  workspaceIdsBeforeStream,
}: ResolveAssistantMessageRefsProps): ResolveAssistantMessageRefsResult => {
  const observedWorkspaceIdsAfterStream = refRegistry.getObservedWorkspaceIds();
  const turnWorkspaceIds = new Set<SafeId<"workspace">>();
  const refBindings: ChatRefBinding[] = [];

  const resolvedMessages = messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const entityContexts: ChatEntityRefContext[] = [];
    const unresolvedInputRefs: ChatUnresolvedInputRefContext[] = [];
    const resolvedParts = message.parts.map((part) =>
      resolveAssistantPartRefs({
        part,
        entityContexts,
        unresolvedInputRefs,
        refRegistry,
      }),
    );
    const parts = synchronizeToolResultContent(resolvedParts);
    const messageWorkspaceIds = computeAssistantTurnWorkspaceIds({
      accessibleWorkspaceIds,
      opaqueReadWorkspaceIds,
      observedWorkspaceIdsAfterStream,
      responseParts: parts,
      workspaceIdsBeforeStream,
    });
    for (const id of messageWorkspaceIds) {
      turnWorkspaceIds.add(id);
    }
    const shownRefBindings = refRegistry.collectRefBindings(
      chatRefsWrittenIn({ isServerTool, parts: message.parts }),
    );
    refBindings.push(...shownRefBindings);
    const refContext = {
      version: 2,
      refs: shownRefBindings,
      entities: entityContexts,
      unresolvedInputs: unresolvedInputRefs,
      workspaceScope: messageWorkspaceIds.map((id) =>
        resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id }),
      ),
    } satisfies ChatRefContext;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        refContext,
        refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
      },
      parts,
    };
  });

  return {
    messages: resolvedMessages,
    refBindings,
    workspaceIds: [...turnWorkspaceIds],
  };
};

type HydrateAssistantMessageRefsProps = {
  messages: ChatMessage[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
};

const hydrateAssistantMessageRefs = ({
  messages,
  refRegistry,
}: HydrateAssistantMessageRefsProps): ChatMessage[] => {
  // A persisted tool call carries its declared refs resolved to real ids.
  // Re-mint its input and output paths before the generic field-policy walk,
  // using the server-owned entity context when no matter input is present.
  const hydrateToolCallPart = (
    part: ChatMessage["parts"][number],
    entityContexts: readonly ChatEntityRefContext[],
    inputState: ChatRefInputState,
    unresolvedInputRefs: readonly ChatUnresolvedInputRefContext[],
  ): unknown => {
    if (part.type !== "tool-call") {
      return part;
    }
    const rawInput: unknown = "input" in part ? part.input : undefined;
    const input =
      rawInput === undefined
        ? undefined
        : hydrateRegistryToolInputRefs({
            entityContexts,
            input: rawInput,
            inputState,
            refRegistry,
            toolName: part.name,
            unresolvedInputRefs,
          });
    const output =
      "output" in part
        ? hydrateRegistryToolOutputRefs({
            entityContexts,
            input: rawInput,
            inputState,
            output: part.output,
            refRegistry,
            toolName: part.name,
          })
        : undefined;
    return {
      ...part,
      ...(input === undefined
        ? {}
        : { input, arguments: JSON.stringify(input) }),
      ...(output === undefined ? {} : { output }),
    };
  };

  const hydratePart = (
    part: ChatMessage["parts"][number],
    entityContexts: readonly ChatEntityRefContext[],
    inputState: ChatRefInputState,
    unresolvedInputRefs: readonly ChatUnresolvedInputRefContext[],
  ): ChatMessage["parts"][number] => {
    const withDeclaredToolRefs = hydrateToolCallPart(
      part,
      entityContexts,
      inputState,
      unresolvedInputRefs,
    );
    const hydrated =
      refRegistry.hydrateAssistantValueRefs(withDeclaredToolRefs);
    if (!isChatPart(hydrated)) {
      panic("Hydrating assistant refs changed the message part shape");
    }
    return hydrated;
  };

  // User text carries persisted mention hrefs too: composer mention chips
  // serialize as `#stella-entity=<ws>:<ent>` / `#stella-workspace=<ws>`
  // links (chat-message.ts `toMentionHref`), and compaction checkpoints are
  // persisted as user-role messages. Hydrating them keeps raw tenant UUIDs
  // out of the model context while preserving what the user pointed at.
  const hydrateUserPart = (
    part: ChatMessage["parts"][number],
  ): ChatMessage["parts"][number] =>
    part.type === "text"
      ? {
          ...part,
          content: refRegistry.hydrateUserTextRefs(
            // Pasted workspace URLs first: "Copy link" and the URL bar give
            // the user a raw workspace UUID the ingress guard would redact;
            // rewriting to a mention keeps the pointing intent as a ref.
            rewriteWorkspaceUrlsToMentions({
              appBaseUrl: getAppBaseUrl(),
              refRegistry,
              text: part.content,
            }),
          ),
        }
      : part;

  const hydrateCompactionPart = (
    part: ChatMessage["parts"][number],
  ): ChatMessage["parts"][number] =>
    part.type === "text"
      ? { ...part, content: refRegistry.hydrateAssistantTextRefs(part.content) }
      : part;

  const hydratedMessages: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const inputState = resolveChatRefInputState(
        message.metadata?.refEncoding,
      );
      const refContext = message.metadata?.refContext;
      const validatedRefContext = isChatRefContext(refContext)
        ? refContext
        : undefined;
      if (
        inputState === CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2 &&
        validatedRefContext === undefined
      ) {
        panic("Stored chat reference context is invalid");
      }
      const entityContexts =
        validatedRefContext === undefined ? [] : validatedRefContext.entities;
      const unresolvedInputRefs =
        validatedRefContext === undefined
          ? []
          : validatedRefContext.unresolvedInputs;
      const hydratedParts = message.parts.map((part) => {
        let toolCallId: string | undefined;
        if (part.type === "tool-call") {
          toolCallId = part.id;
        } else if (part.type === "tool-result") {
          toolCallId = part.toolCallId;
        }
        const partEntityContexts =
          toolCallId === undefined
            ? []
            : entityContexts.filter(
                (context) => context.toolCallId === toolCallId,
              );
        const partUnresolvedInputRefs =
          toolCallId === undefined
            ? []
            : unresolvedInputRefs.filter(
                (context) => context.toolCallId === toolCallId,
              );
        return hydratePart(
          part,
          partEntityContexts,
          inputState,
          partUnresolvedInputRefs,
        );
      });
      hydratedMessages.push({
        ...message,
        // Ref context is persistence-only. Hydration has consumed it, and
        // leaving raw workspace ids in message metadata would make the
        // provider-bound ingress guard report a false residual-id leak.
        ...(message.metadata === undefined
          ? {}
          : { metadata: { ...message.metadata, refContext: undefined } }),
        parts: synchronizeToolResultContent(hydratedParts),
      });
      continue;
    }
    if (message.role === "user") {
      hydratedMessages.push({
        ...message,
        parts: message.parts.map(
          message.id === COMPACTION_SUMMARY_MESSAGE_ID
            ? hydrateCompactionPart
            : hydrateUserPart,
        ),
      });
      continue;
    }
    hydratedMessages.push(message);
  }
  return hydratedMessages;
};

type RecomputeThreadDataScopeProps = {
  accessibleSet: ReadonlySet<string>;
  baseWorkspaceId: SafeId<"workspace"> | null;
  messages: readonly ChatMessage[];
};

const recomputeThreadDataScope = ({
  accessibleSet,
  baseWorkspaceId,
  messages,
}: RecomputeThreadDataScopeProps): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  if (baseWorkspaceId !== null && accessibleSet.has(baseWorkspaceId)) {
    ids.add(baseWorkspaceId);
  }
  for (const id of extractThreadDataWorkspaceIds(messages)) {
    if (accessibleSet.has(id)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
};

const workspaceIdsEqual = (
  a: readonly SafeId<"workspace">[],
  b: readonly SafeId<"workspace">[],
): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set<string>(a);
  return b.every((id) => set.has(id));
};
