import { panic, Result } from "better-result";
import type { InferOk } from "better-result";
import { deepEquals } from "bun";
import { and, eq } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import {
  CHAT_TURN_INTENT,
  resourceRef,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import { DOCX_SUGGESTION_SURFACE } from "@stll/api-contract/chat-docx-suggestions";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  getActiveFileModelBinding,
  type ActiveFileModelBinding,
  type ActiveFileSourceForModel,
} from "@/api/handlers/chat/active-file-model-source";
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
} from "@/api/handlers/chat/chat-message-persistence";
import {
  appendAnonymizedModeHintToChatSafePrompt,
  buildChatPromptCacheKey,
  buildChatSystemPromptParts,
  extendChatUntrustedPromptSuffix,
  extractTitle,
} from "@/api/handlers/chat/chat-prompt";
import type {
  ChatSafePrompt,
  ChatToolAvailability,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
import { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
import type {
  ChatSendRequest,
  IncomingActiveDecision,
  IncomingActiveDraft,
  IncomingActiveExternal,
  IncomingActiveFile,
  IncomingActiveSkill,
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
  validateToolCallParts,
  validateMessage,
} from "@/api/handlers/chat/chat-schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  CHAT_METERED_PROVIDER_TIMEOUT_MS,
  renewChatTurnExecutionLease,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
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
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import { planMessagePersistence } from "@/api/handlers/chat/persist-message";
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
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  intersectAccessibleWorkspaceIds,
  resolveToolWorkspaceIds,
} from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { hasSuggestChangesApprovalResponse } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import {
  areSubagentToolsRegistered,
  areTemplateAuthoringToolsRegistered,
  areWebResearchToolsRegistered,
  getChatTools,
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
  hydrateRegistryToolInputRefs,
  resolveRegistryToolInputRefs,
} from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import {
  hydrateRegistryToolOutputRefs,
  resolveRegistryToolOutputRefs,
} from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
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
} from "@/api/handlers/chat/types";
import { createRawChatFilePart } from "@/api/handlers/chat/upload-files";
import type { UploadedChatFile } from "@/api/handlers/chat/upload-files";
import { attachVerifiedEntityMentionKinds } from "@/api/handlers/chat/verified-mention-kinds";
import {
  resolveActiveChatSkillContext,
  type ActiveChatSkillContext,
} from "@/api/lib/agent-skills/skills";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  assertUsageAvailableForHandler,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveEffectiveChatModelSelection } from "@/api/lib/chat-model-selection";
import {
  canUseChatThreadForGeneratedDocumentDraft,
  createGeneratedDocumentActiveDraftContext,
  hasPersistedGeneratedDocumentActiveDraftContext,
} from "@/api/lib/chat/active-draft-context";
import { isReadyGeneratedDocumentDraft } from "@/api/lib/chat/created-draft";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_ENCODING,
  CHAT_REF_INPUT_STATE,
  isChatRefContext,
  resolveChatRefInputState,
  type ChatEntityRefContext,
  type ChatRefContext,
  type ChatRefInputState,
  type ChatUnresolvedInputRefContext,
} from "@/api/lib/chat/ref-token";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { rewriteWorkspaceUrlsToMentions } from "@/api/lib/chat/workspace-url-mentions";
import { detached } from "@/api/lib/detached";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/files/utils";
import {
  FILE_SIZE_LIMIT_BYTES,
  FILE_SIZE_LIMITS,
  LIMITS,
} from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import { getDisabledNativeToolSlugs } from "@/api/lib/mcp-connectors/catalog-metadata";
import { resolveMemorySourceWorkspaceIds } from "@/api/lib/memory/memory-provenance";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import {
  requireTanStackAIAvailableForRole,
  validateTanStackDevModelOverride,
} from "@/api/lib/tanstack-ai-models";
import type { UsageLaneDecision } from "@/api/lib/usage/lane-routing";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";
import { PDF_MIME_TYPE } from "@/api/mime-types";

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
  if (!env.isDev) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Dev model overrides are only available locally.",
      }),
    );
  }
  return validateTanStackDevModelOverride(devModelId, orgAIConfig);
};

/**
 * Whether the delegation tool is offered on this turn: only at the top level,
 * and only when the turn's scope (if any) allows `spawn_subagents`. Kept as a
 * top-level helper so the streaming handler stays within its cognitive-
 * complexity budget.
 */
const areSubagentToolsAvailableForTurn = (
  toolScope: ChatToolScope | undefined,
): boolean =>
  areSubagentToolsRegistered({ delegationDepth: 0 }) &&
  (toolScope === undefined ||
    scopeAllowsTool(toolScope, SPAWN_SUBAGENTS_TOOL_NAME));

const normalizeOptionalArray = <T>(value: T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }
  return value;
};

const config = {
  permissions: { chat: ["create"] },
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
      status: "preflight" | "streaming";
      execution: ChatTurnExecution;
      owningAssistantMessage?: PersistableChatMessage | undefined;
    };

type ChatSendLifecycleOptions = {
  externalMcpToolsLoader: LazyExternalMcpToolsLoader;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  rollbackSideEffects: typeof rollbackUnpersistedChatSideEffects;
};

/** Owns every resource that must be settled when a send stops before streaming. */
class ChatSendLifecycle {
  private readonly options: ChatSendLifecycleOptions;
  private claimedTurn: ClaimedChatTurnOwnership = { status: "unclaimed" };
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
  }

  handOffConnectors(loaded: boolean): void {
    this.connectorsHandedOff = loaded;
  }

  markStreaming(): void {
    if (this.claimedTurn.status === "unclaimed") {
      panic("Cannot stream a chat turn without durable ownership");
    }
    this.claimedTurn = {
      status: "streaming",
      execution: this.claimedTurn.execution,
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
    };
  }

  async failCurrentTurn(
    code: ChatTurnFailureCode,
    retryable: boolean,
  ): Promise<void> {
    if (this.claimedTurn.status === "unclaimed") {
      panic("Cannot fail a chat turn without durable ownership");
    }
    const failureResult = await persistFailedChatTurn({
      code,
      execution: this.claimedTurn.execution,
      recordAuditEvent: this.options.recordAuditEvent,
      retryable,
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
    });
    if (Result.isError(failureResult)) {
      captureError(failureResult.error, { threadId: this.options.threadId });
      return;
    }
    this.claimedTurn = { status: "unclaimed" };
  }

  async interruptCurrentTurn() {
    if (this.claimedTurn.status === "unclaimed") {
      return panic("Cannot interrupt a chat turn without durable ownership");
    }
    const settlementResult = await persistInterruptedChatTurn({
      execution: this.claimedTurn.execution,
      owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
      recordAuditEvent: this.options.recordAuditEvent,
      safeDb: this.options.safeDb,
      threadId: this.options.threadId,
      userId: this.options.userId,
      workspaceId: this.options.workspaceId,
    });
    if (Result.isOk(settlementResult)) {
      this.claimedTurn = { status: "unclaimed" };
    }
    return settlementResult;
  }

  async cleanup(): Promise<void> {
    if (this.claimedTurn.status === "preflight") {
      const failureResult = await persistFailedChatTurn({
        code: "internal",
        execution: this.claimedTurn.execution,
        owningAssistantMessage: this.claimedTurn.owningAssistantMessage,
        recordAuditEvent: this.options.recordAuditEvent,
        retryable: true,
        safeDb: this.options.safeDb,
        threadId: this.options.threadId,
        userId: this.options.userId,
        workspaceId: this.options.workspaceId,
      });
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
  }
}

type ThreadValidationState = InferOk<
  Awaited<ReturnType<typeof readThreadValidationState>>
>;

type AcceptIncomingTurnOptions = {
  accessibleSet: ReadonlySet<string>;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  body: ChatSendRequest;
  effectiveContextMatterIds: SafeId<"workspace">[];
  lifecycle: ChatSendLifecycle;
  organizationId: SafeId<"organization">;
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
        turnAcceptance,
      });
      if (Result.isError(persistenceResult)) {
        return Result.err(persistenceResult.error);
      }
      turnExecution = persistenceResult.value;
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
    return Result.ok({
      dataScopeAfterIncomingMessage,
      deleteMessageIdsBeforeLatest,
      latestMessagePlan,
      owningAssistantMessage,
      parsedMessage,
      replayTargetMessageId,
      sandboxRun,
      toolWorkspaceIds,
      turnExecution,
    });
  });

type ChatToolsInput = Parameters<typeof getChatTools>[0];

type PrepareValidatedIncomingMessageOptions = {
  dependencies: {
    loadWebSearchProviders: typeof loadWebSearchProvidersForOrg;
    uploadMessageFiles: typeof uploadMessageFilesWithRollback;
  };
  authorization: {
    accessibleWorkspaceIds: SafeId<"workspace">[];
    memberRole: { role: ChatToolsInput["memberRole"] };
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
    workspaceId: SafeId<"workspace"> | null;
  };
  tools: {
    disabledNativeToolSlugs: ChatToolsInput["disabledNativeToolSlugs"];
    docxEditRepresentation: NonNullable<
      ChatToolsInput["docxEditRepresentation"]
    >;
    editApplyMode: NonNullable<ChatToolsInput["editApplyMode"]>;
    externalMcpToolsLoader: LazyExternalMcpToolsLoader;
    orgAIConfig: OrgAIConfig | null;
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
    workspaceId,
  },
  tools: {
    disabledNativeToolSlugs,
    docxEditRepresentation,
    editApplyMode,
    externalMcpToolsLoader,
    orgAIConfig,
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
    const webSearchProviders = await loadWebSearchProviders(organizationId);

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
    const validationTools = getChatTools({
      organizationId,
      memberRole: memberRole.role,
      orgAIConfig,
      pinServerValidatedWorkspaceId,
      requestWorkspaceId: workspaceId,
      refRegistry,
      toolDefectMemo,
      safeDb,
      scopedDb,
      threadId: body.threadId,
      workspaceId,
      userId,
      // Schema validation only; this tool set's `spawn_subagents` never
      // executes, so a raw (non-anonymizing) boundary is correct here —
      // the real per-request boundary is created below and threaded
      // into the streaming tool set instead.
      thirdPartyBoundary: { type: "raw" },
      // Schema validation runs against the user's full accessible
      // set; per-tool scope checks happen at execute time below.
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds,
      }),
      activeFile: activeFileForTools,
      hasActiveDocxEditClient: true,
      hasActiveDocxFileClient: true,
      // Validation must admit persisted calls from either surface; the file
      // overlay's operation set is the superset.
      docxSuggestionSurface: DOCX_SUGGESTION_SURFACE.fileOverlay,
      editApplyMode,
      docxEditRepresentation,
      includeAllDocxEditToolsForValidation: true,
      includeRememberToolForValidation: true,
      webSearchEnabled: validationThreadState.webSearchEnabled,
      webSearchProviders,
      externalTools: externalToolsForValidation,
      disabledNativeToolSlugs,
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
            await assertUsageAvailableForHandler({
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
      if (poolCheck !== null) {
        return Result.err(poolCheck);
      }
      turnLane = { lane: "pool" };
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

export type SendMessageDependencies = {
  indexThread: typeof upsertChatThreadSearchDocument;
  loadExternalMcpTools: typeof loadExternalMcpToolsForUser;
  loadWebSearchProviders: typeof loadWebSearchProvidersForOrg;
  rollbackSideEffects: typeof rollbackUnpersistedChatSideEffects;
  streamResponse: typeof streamChat;
  uploadMessageFiles: typeof uploadMessageFilesWithRollback;
};

const SEND_MESSAGE_DEPENDENCIES: SendMessageDependencies = {
  indexThread: upsertChatThreadSearchDocument,
  loadExternalMcpTools: loadExternalMcpToolsForUser,
  loadWebSearchProviders: loadWebSearchProvidersForOrg,
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChat,
  uploadMessageFiles: uploadMessageFilesWithRollback,
};

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
      /* eslint-disable no-body-ownership-ids/no-body-ownership-ids -- root handler; resolveChatScope performs targeted workspace authorization */
      const scope = yield* resolveChatScope({
        getWorkspaceAccess,
        workspaceId: body.workspaceId,
      });
      /* eslint-enable no-body-ownership-ids/no-body-ownership-ids */

      const workspaceId =
        scope.scope === "workspace" ? scope.workspaceId : null;
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

      const refRegistry = createChatRefRegistry();
      // Turn-scoped alongside the ref registry: records tool calls that failed
      // with a server defect so every toolset built this turn refuses to
      // re-execute the identical call (see `ChatToolDefectMemo`).
      const toolDefectMemo = createChatToolDefectMemo();
      // Narrower than the combined `suggest_changes` gate below:
      // only the file overlay (`file-chat-overlay.tsx`) mounts the
      // auto-run watcher that resolves the folio-agents `read_document` /
      // `find_text` tools via `addToolResult`. Template Studio has no such
      // watcher, so a tool call there would hang the session until reload.
      // Computed once and reused for tool registration (validation +
      // streaming) and for the matching prompt guidance below.
      const hasActiveDocxFileClient =
        body.activeFile?.supportsDocxEdits === true;
      // Which client executor resolves `suggest_changes`, hence which
      // per-surface schema the model sees. Only Template Studio narrows to
      // text replacements; the file overlay hosts both entity-backed files
      // and unsaved generated drafts with the full operation set.
      const docxSuggestionSurface =
        body.activeTemplate !== undefined
          ? DOCX_SUGGESTION_SURFACE.templateStudio
          : DOCX_SUGGESTION_SURFACE.fileOverlay;
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
            safeDb,
            userId: user.id,
          }),
      );
      const lifecycle = new ChatSendLifecycle({
        externalMcpToolsLoader,
        recordAuditEvent,
        safeDb,
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
              workspaceId,
            },
            tools: {
              disabledNativeToolSlugs,
              docxEditRepresentation,
              editApplyMode,
              externalMcpToolsLoader,
              orgAIConfig,
              refRegistry,
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

        const acceptedTurnResult = await acceptIncomingTurn({
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
          sandboxRun,
          toolWorkspaceIds,
          turnExecution,
        } = acceptedTurnResult.value;

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

        const messagesForContextInput = await selectMessagesForContextInput({
          messages: latestMessagePlan.messages,
          safeDb,
          skipCheckpoint: replayTargetMessageId !== undefined,
          threadId: body.threadId,
        });

        // Compaction can issue a metered provider request. The turn was claimed
        // above, so a concurrent send is rejected before either request starts
        // this work. Its terminal state remains explicit on every preflight exit.
        const createMeteredAIAbortSignal = () =>
          AbortSignal.timeout(CHAT_METERED_PROVIDER_TIMEOUT_MS);
        if (isClientConnectionAborted()) {
          yield* Result.await(lifecycle.interruptCurrentTurn());
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Client disconnected before AI work started",
            }),
          );
        }

        const messagesForContextResult = await compactMessagesForContext({
          abortSignal: createMeteredAIAbortSignal(),
          boundary: thirdPartyBoundary,
          chatModelOverride,
          messages: messagesForContextInput,
          organizationId: session.activeOrganizationId,
          orgAIConfig,
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
          hasActiveDocxEditClient:
            hasActiveDocxFileClient ||
            body.activeDraft !== undefined ||
            body.activeTemplate !== undefined,
          memberRole: memberRole.role,
          recordAuditEventAvailable: true,
          requestWorkspaceId: workspaceId,
          toolWorkspaceIds,
          workspaceStatusById,
        });
        const chatContextResult = await prepareChatContext({
          activeDecision: body.activeDecision,
          activeDraft: body.activeDraft,
          activeExternal: body.activeExternal,
          activeFile: body.activeFile,
          activeSkill: body.activeSkill,
          activeTemplate: body.activeTemplate,
          contextMatterIds: effectiveContextMatterIds,
          memberRole,
          latestMentions: parsedMessage.mentions,
          latestUserMessageId: parsedMessage.message.id,
          messageWindow: messagesForContextResult.value,
          organizationId: session.activeOrganizationId,
          safeDb,
          sendMode: body.sendMode,
          toolAvailability: {
            docxEditMode: registeredDocxEditMode,
            templateAuthoring: areTemplateAuthoringToolsRegistered(
              memberRole.role,
            ),
            webResearch: areWebResearchToolsRegistered({
              webSearchEnabled: thread.data.webSearchEnabled,
              webSearchProviders,
              disabledNativeToolSlugs,
            }),
            folioAgentDocTools: hasActiveDocxFileClient,
            subagents: areSubagentToolsAvailableForTurn(body.toolScope),
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
          createAIAbortSignal: createMeteredAIAbortSignal,
          organizationId: session.activeOrganizationId,
          memberRole: memberRole.role,
          orgAIConfig,
          promptCachingEnabled,
          usageLane: turnLane.lane,
          pinServerValidatedWorkspaceId,
          requestWorkspaceId: workspaceId,
          refRegistry,
          toolDefectMemo,
          safeDb,
          scopedDb,
          threadId: body.threadId,
          workspaceId,
          thirdPartyBoundary,
          excludedChatHistoryMessageIds: deleteMessageIdsBeforeLatest,
          userId: user.id,
          toolWorkspaceIds,
          activeFile: activeFileForTools,
          hasActiveDocxEditClient:
            hasActiveDocxFileClient ||
            body.activeDraft !== undefined ||
            body.activeTemplate !== undefined,
          hasActiveDocxFileClient,
          docxSuggestionSurface,
          editApplyMode,
          docxEditRepresentation,
          webSearchEnabled: thread.data.webSearchEnabled,
          webSearchProviders,
          externalTools: externalMcpTools?.tools ?? {},
          disabledNativeToolSlugs,
          skillMetadata: chatContext.skillMetadata,
          activeSkillContext: chatContext.activeSkillContext,
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
          resolveMemorySourceWorkspaceIds: () =>
            resolveMemorySourceWorkspaceIds({
              accessibleWorkspaceIds: accessibleSet,
              contextMatterIds: effectiveContextMatterIds,
              dataWorkspaceIds: dataScopeAfterIncomingMessage,
              registeredWorkspaceIds: refRegistry.getRegisteredWorkspaceIds(),
              workspaceId,
            }),
          workspaceStatusById,
        });
        // A named scope narrows the streaming turn to its server-defined
        // allowlist (validation above stays broad so persisted tool parts
        // keep validating). The scope name is schema-validated; unknown
        // names never reach this point.
        const streamingTools =
          body.toolScope === undefined
            ? chatTools
            : restrictChatToolsToScope(chatTools, body.toolScope);

        const externalMcpSystemHint = buildExternalMcpSystemHint(
          externalMcpTools === undefined ? [] : externalMcpTools.connectors,
        );
        // The "safe" half is whatever the prompt builder declared
        // safe. The anonymized-mode hint is a fixed assembler-owned
        // addition, so callers cannot brand arbitrary strings as safe.
        // The external MCP catalog is organization/user-configured text,
        // so it rides with the dynamic suffix and crosses the boundary in
        // anonymized mode.
        const systemSafe =
          body.sendMode === CHAT_SEND_MODE.anonymized
            ? appendAnonymizedModeHintToChatSafePrompt(chatContext.systemSafe)
            : chatContext.systemSafe;
        const systemUntrusted = extendChatUntrustedPromptSuffix(
          chatContext.systemUntrusted,
          [externalMcpSystemHint],
        );

        // A normal chat hands loaded clients to the stream. Agent runs leave
        // this false so the outer finally closes any validation-only load.
        lifecycle.handOffConnectors(externalMcpTools !== undefined);
        const response = yield* Result.await(
          Result.tryPromise({
            try: async () => {
              try {
                if (isClientConnectionAborted()) {
                  throw new HandlerError({
                    status: 400,
                    message: "Client disconnected before stream started",
                  });
                }

                // Connector discovery and prompt assembly can take meaningful
                // time. Renew immediately before provider dispatch so the
                // durable owner covers the entire provider timeout, rather than
                // only the earlier preflight window.
                const leaseRenewal = await renewChatTurnExecutionLease({
                  execution: turnExecution,
                  safeDb,
                });
                if (Result.isError(leaseRenewal)) {
                  throw new HandlerError({
                    status: 500,
                    message: "Failed to renew chat execution lease",
                    cause: leaseRenewal.error,
                  });
                }
                if (!leaseRenewal.value) {
                  throw new HandlerError({
                    status: 409,
                    message: "Chat turn lost its durable execution owner",
                  });
                }

                // Snapshot the refs the registry already holds before streaming.
                // Prompt-time pins (`contextMatterIds` → `toMatterRef`) are
                // resolved during prompt construction; folding the WHOLE registry
                // into thread scope at onFinish would over-broaden it to pinned-
                // but-never-read matters, which could make the thread unreadable
                // after that matter's access is revoked even though its content was
                // never persisted. Only the delta minted DURING the stream (a
                // matter/entity a tool or subagent actually read) should widen
                // `data_workspace_ids`.
                const workspaceIdsBeforeStream = new Set(
                  refRegistry.getRegisteredWorkspaceIds(),
                );

                const chatResponse = await dependencies.streamResponse({
                  abortSignal: createMeteredAIAbortSignal(),
                  runId: body.runId,
                  ...(parentRunId === undefined ? {} : { parentRunId }),
                  ...(resume === undefined ? {} : { resume }),
                  messages: chatContext.hydratedMessages,
                  latestMessageId: parsedMessage.message.id,
                  ...(owningAssistantMessage === undefined
                    ? {}
                    : { owningAssistantMessageId: owningAssistantMessage.id }),
                  onFinish: async ({ outcome, responseMessage }) => {
                    const validatedToolParts = validateToolCallParts({
                      allowPartialInput: outcome.type === "interrupted",
                      message: responseMessage,
                      tools: streamingTools,
                    });
                    if (Result.isError(validatedToolParts)) {
                      throw new HandlerError({
                        status: 500,
                        message: "Generated chat tool parts are invalid",
                        cause: validatedToolParts.error,
                      });
                    }
                    const canonicalResponseMessage = toPersistableChatMessage({
                      ...responseMessage,
                      parts: validatedToolParts.value,
                    });
                    const resolved = resolveAssistantMessageRefs({
                      accessibleWorkspaceIds: accessibleSet,
                      messages: [canonicalResponseMessage],
                      opaqueReadWorkspaceIds:
                        body.runMode === CHAT_RUN_MODE.agent
                          ? toolWorkspaceIds
                          : [],
                      refRegistry,
                      workspaceIdsBeforeStream,
                    });
                    const resolvedResponseMessage = resolved.messages.at(0);
                    if (!resolvedResponseMessage) {
                      panic("Missing chat response message");
                    }

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
                      dataScopeExpansion: {
                        newWorkspaceIds: resolved.workspaceIds,
                      },
                      existingIds: latestMessagePlan.existingIds,
                      execution: turnExecution,
                      outcome,
                      recordAuditEvent,
                      responseMessage: resolvedResponseMessage,
                      safeDb,
                      threadId: body.threadId,
                      userId: user.id,
                      workspaceId,
                      indexThread: dependencies.indexThread,
                    });

                    if (Result.isError(persistResult)) {
                      captureError(persistResult.error, {
                        threadId: body.threadId,
                      });
                      await lifecycle.failCurrentTurn("persistence", true);
                      throw new HandlerError({
                        status: 500,
                        message: "Failed to persist assistant turn",
                        cause: persistResult.error,
                      });
                    } else {
                      const { persistencePlan } = persistResult.value;
                      const messagesAfterAssistantPersist =
                        applyAssistantPersistencePlan({
                          messages: latestMessagePlan.messages,
                          persistencePlan,
                        });
                      if (
                        outcome.type === "completed" &&
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
                        outcome.type === "completed" &&
                        thread.type === "created" &&
                        body.sendMode !== CHAT_SEND_MODE.anonymized
                      ) {
                        detached(
                          generateThreadTitle({
                            initialTitle: initialThreadTitle,
                            messages: [
                              parsedMessage.message,
                              resolvedResponseMessage,
                            ],
                            organizationId: session.activeOrganizationId,
                            orgAIConfig,
                            promptCachingEnabled,
                            recordAuditEvent,
                            safeDb,
                            threadId: body.threadId,
                            threadWorkspaceId: workspaceId,
                            userId: user.id,
                          }),
                          "send-message.generate-thread-title",
                        );
                      }
                    }
                  },
                  orgAIConfig,
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

                if (
                  externalMcpTools !== undefined &&
                  !isChatStreamResponse(chatResponse)
                ) {
                  await externalMcpTools.close();
                  // streamChat can reject before it creates an SSE stream (for
                  // example an anonymization-boundary or attachment-modality
                  // refusal). No terminal middleware hook runs in that branch,
                  // so settle the claimed turn here instead of leaving it
                  // indefinitely running.
                  await lifecycle.failCurrentTurn(
                    "internal",
                    chatResponse.status >= 500,
                  );
                } else {
                  lifecycle.markStreaming();
                }

                return chatResponse;
              } catch (error) {
                if (externalMcpTools !== undefined) {
                  await externalMcpTools.close();
                }
                await lifecycle.failCurrentTurn("internal", true);
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

const isChatStreamResponse = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  return contentType?.includes("text/event-stream") === true;
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
  activeDecision: IncomingActiveDecision | undefined;
  activeDraft: IncomingActiveDraft | undefined;
  activeExternal: IncomingActiveExternal | undefined;
  activeFile: IncomingActiveFile | undefined;
  activeSkill: IncomingActiveSkill | undefined;
  activeTemplate: IncomingActiveTemplate | undefined;
  contextMatterIds: SafeId<"workspace">[];
  memberRole: { role: string };
  latestMentions: readonly ChatMention[];
  latestUserMessageId: string;
  messageWindow: ChatMessage[];
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
    systemSafe: ChatSafePrompt;
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
  activeDecision,
  activeDraft,
  activeExternal,
  activeFile,
  activeSkill,
  activeTemplate,
  contextMatterIds,
  memberRole,
  latestMentions,
  latestUserMessageId,
  messageWindow,
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
        activeDecision,
        activeDraft,
        activeExternal,
        activeFile,
        activeSkill,
        activeTemplate,
        contextMatterIds,
        memberRole,
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
      systemSafe: systemPrompt.safePrompt,
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
    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () => await readS3ArrayBuffer(s3Key),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to read active file for AI context",
            cause,
          }),
      }),
    );
    if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.chatContextFile) {
      return Result.err(activeFileSizeLimitError());
    }

    if (source.type === "extracted-text") {
      const extracted = await extractFileTextResult(buffer, source.mimeType);
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
  messages: PersistableChatMessage[];
  opaqueReadWorkspaceIds: readonly SafeId<"workspace">[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
  workspaceIdsBeforeStream: ReadonlySet<SafeId<"workspace">>;
};

type ResolveAssistantMessageRefsResult = {
  messages: PersistableChatMessage[];
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

const resolveAssistantMessageRefs = ({
  accessibleWorkspaceIds,
  messages,
  opaqueReadWorkspaceIds,
  refRegistry,
  workspaceIdsBeforeStream,
}: ResolveAssistantMessageRefsProps): ResolveAssistantMessageRefsResult => {
  const resolvePart = (
    part: ChatMessage["parts"][number],
    entityContexts: ChatEntityRefContext[],
    unresolvedInputRefs: ChatUnresolvedInputRefContext[],
  ): ChatMessage["parts"][number] => {
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
    const resolved =
      refRegistry.resolveAssistantValueRefs(withDeclaredToolRefs);
    if (!isChatPart(resolved)) {
      panic("Resolving assistant refs changed the message part shape");
    }
    return resolved;
  };

  const registeredWorkspaceIdsAfterStream =
    refRegistry.getRegisteredWorkspaceIds();
  const turnWorkspaceIds = new Set<SafeId<"workspace">>();

  const resolvedMessages = messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const entityContexts: ChatEntityRefContext[] = [];
    const unresolvedInputRefs: ChatUnresolvedInputRefContext[] = [];
    const resolvedParts = message.parts.map((part) =>
      resolvePart(part, entityContexts, unresolvedInputRefs),
    );
    const parts = synchronizeToolResultContent(resolvedParts);
    const messageWorkspaceIds = computeAssistantTurnWorkspaceIds({
      accessibleWorkspaceIds,
      opaqueReadWorkspaceIds,
      registeredWorkspaceIdsAfterStream,
      responseParts: parts,
      workspaceIdsBeforeStream,
    });
    for (const id of messageWorkspaceIds) {
      turnWorkspaceIds.add(id);
    }
    const refContext = {
      version: 1,
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

  return { messages: resolvedMessages, workspaceIds: [...turnWorkspaceIds] };
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
