import { EventType, maxIterations, RUN_CANCEL_REASON } from "@tanstack/ai";
import type {
  AnyServerTool,
  ChatMiddleware,
  ChatMiddlewareConfig,
  ModelMessage,
  RunAgentResumeItem,
  StreamChunk,
  TokenUsage,
  UIMessage,
} from "@tanstack/ai";
import { panic, Result } from "better-result";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  resolveStellaSandboxRun,
  type StellaSandboxRunInput,
} from "@stll/agent-engine";
import {
  getModelImageInputCapability,
  type ModelRole,
  type ReasoningEffort,
} from "@stll/ai-catalog";
import {
  CHAT_SEND_MODE,
  createThirdPartyBoundaryRefusalPayload,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { Temporal } from "@stll/time";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { userFiles } from "@/api/db/schema";
import type { UsageEventLane } from "@/api/db/schema";
import type { AnonymizationRefusal } from "@/api/handlers/chat/anonymization-refusal";
import { refuseAnonymizedCrossing } from "@/api/handlers/chat/anonymization-refusal";
import { modelAcceptsDocumentAttachment } from "@/api/handlers/chat/attachment-modality";
import { chunkCarriesAnswer } from "@/api/handlers/chat/attempt-answer";
import {
  applyChatPartPersistenceBudget,
  attachTerminalTurnOutcome,
  classifyChatPartForPersistence,
  getChatAttachmentMimeType,
  getAwaitingUserInteraction,
  getAwaitingUserInteractions,
  getUserFileIdFromAttachmentPart,
  isChatAttachmentPart,
  isChatDocumentPart,
  isChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { chatSafePromptText } from "@/api/handlers/chat/chat-prompt";
import type {
  ChatSafePromptLayers,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
import {
  chatAttemptRequestOptions,
  chatSystemPrompts,
} from "@/api/handlers/chat/chat-request";
import {
  CHAT_RUN_MODE,
  type ChatRunMode,
} from "@/api/handlers/chat/chat-schema";
import {
  OWNER_LOST_OUTCOME,
  USER_STOP_OUTCOME,
} from "@/api/handlers/chat/chat-turn-persistence";
import { CHAT_TURN_OWNER_LOST_REASON } from "@/api/handlers/chat/chat-turn-run";
import type {
  ChatTurnRun,
  ChatTurnStoredSettlement,
} from "@/api/handlers/chat/chat-turn-run";
import {
  CUT_SHORT_OUTCOME,
  findHandedOutInteraction,
} from "@/api/handlers/chat/chat-turn-settlement";
import type { CutShortOutcome } from "@/api/handlers/chat/chat-turn-settlement";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import { compactModelMessagesForModel } from "@/api/handlers/chat/compaction";
import {
  createLoopRecoverySystemPrompt,
  detectModelLoop,
  getLoopRecoveryKey,
  shouldInjectLoopRecovery,
  shouldSurfaceFinalContentLoop,
  shouldStopLoopRecovery,
} from "@/api/handlers/chat/loop-detector";
import { guardProviderHistory } from "@/api/handlers/chat/provider-history";
import type { GuardedProviderHistory } from "@/api/handlers/chat/provider-history";
import { stampReasoningProvenance } from "@/api/handlers/chat/reasoning-provenance-stamp";
import {
  assistantMessageStartChunk,
  createTurnMessageIdMapper,
  ensureAssistantMessageStart,
  findDeniedApprovals,
  keepDeniedApprovalsOnScreen,
  normalizeFinalAssistantMessageId,
  presentStoredHistory,
  remapOutgoingMessageIds,
} from "@/api/handlers/chat/stream-message-identity";
import type {
  DeniedApproval,
  MessageIdMapper,
  StoredHistory,
} from "@/api/handlers/chat/stream-message-identity";
import {
  createTanStackTerminalHooks,
  tanStackStreamEventLifecycle,
} from "@/api/handlers/chat/tanstack-chat-lifecycle";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  deanonymizeFromBoundary,
  deanonymizeUnknownStringsFromBoundary,
  prepareMcpToolSourceForThirdParty,
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
  prepareUnknownForThirdParty,
  reserveThirdPartyBoundarySourcePlaceholders,
} from "@/api/handlers/chat/third-party-boundary";
import { sortToolJsonKeys } from "@/api/handlers/chat/tool-json-key-order";
import type { StellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { resolveChatTurnModel } from "@/api/handlers/chat/turn-model";
import type { ChatTurnModel } from "@/api/handlers/chat/turn-model";
import type {
  ChatAnonRestoration,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessageUsage,
  ChatPart,
  ChatTurnOutcome,
  PersistableChatMessage,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import { hydrateFilePart } from "@/api/handlers/chat/upload-files";
import type { VisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import type { CachingDecision, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  classifyAIError,
  classifyRejectedProviderRequest,
  isAnticipatedAIFailure,
  providerErrorBody,
  providerStatusFields,
} from "@/api/lib/ai-error";
import type { AIErrorKind } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  chatToolMapToArray,
  type ChatTool,
  type ChatToolMap,
} from "@/api/lib/chat/chat-tool-types";
import {
  guardMcpToolSource,
  guardModelMessages,
  guardModelSystemPrompt,
  guardModelToolSchemas,
  redactModelSystemPrompt,
} from "@/api/lib/chat/model-ingress-guard";
import type {
  GuardedMcpToolSource,
  GuardedModelMessages,
  GuardedSystemPrompt,
  GuardedToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";
import {
  IMAGE_INPUT_UNSUPPORTED_CODE,
  imageInputUnsupportedError,
} from "@/api/lib/chat/provider-image-input";
import {
  withProviderStreamContract,
  withRunToolCallIds,
} from "@/api/lib/chat/provider-stream-contract";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatRunLog } from "@/api/lib/chat/run-log";
import {
  createStreamMessageCapture,
  type ChatStreamProcessor,
} from "@/api/lib/chat/stream-message-capture";
import {
  finishReasonOf,
  streamChatChunks,
  toolCallEndInputOf,
  toolCallEndOutputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { ToolCallIdLedger } from "@/api/lib/chat/unique-tool-call-ids";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
} from "@/api/lib/errors/tagged-errors";
import type { ChatTerminalError } from "@/api/lib/errors/tagged-errors";
import { errorFingerprint } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  providerErrorFields,
  providerErrorReason,
} from "@/api/lib/observability/provider-error-reason";
import type { PromptCacheMetricSurface } from "@/api/lib/observability/request-metrics";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
} from "@/api/lib/rate-limit/action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
import {
  modelAcceptsStreamingToolUse,
  validateTanStackDevModelOverride,
} from "@/api/lib/tanstack-ai-models";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";
import {
  safeTokenUsageFromTerminalChunk,
  tokenUsageFromTerminalChunk,
} from "@/api/lib/tanstack-ai-usage";
import { projectVisualPreviewStream } from "@/api/lib/visual-preview-stream";

const MAX_TOOL_STEPS = 100;
const THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE =
  "Cannot send this attachment to the AI in anonymized mode because stella cannot extract and anonymize it safely.";
const STELLA_ANON_RESTORATIONS_EVENT = "stella.anon-restorations";
const ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL = "stella-assistant-response";
const CHAT_LOOP_DETECTED_MESSAGE =
  "The AI model repeated the same work and could not recover. Please try again with a narrower request.";
const CHAT_EMPTY_COMPLETION_MESSAGE =
  "Model returned finish_reason=stop with zero output";

type StoredUserFile = Pick<
  typeof userFiles.$inferSelect,
  | "extractedText"
  | "fileName"
  | "id"
  | "mimeType"
  | "s3Key"
  | "threadId"
  | "userId"
>;

type AssistantValueRefResolver = ChatRefRegistry["resolveAssistantValueRefs"];
type AssistantToolInputRefResolver = (props: {
  input: unknown;
  toolName: string;
}) => unknown;
type AssistantToolOutputRefResolver = (props: {
  output: unknown;
  toolName: string;
}) => unknown;

export type StreamChatFinishEvent = {
  outcome: ChatTurnOutcome;
  responseMessage: PersistableTerminalAssistantMessage;
};

type StreamChatProps = {
  visualOrigin?: Pick<VisualResourceOrigin, "accepts"> | undefined;
  /**
   * Explicit chat model override for this turn: the dev-only
   * `body.devModelId`, or (in prod) a validated per-thread selection
   * already resolved by `resolveEffectiveChatModelId`. Undefined falls
   * through to the org/instance chat-role default.
   */
  devModelId?: string | undefined;
  /** Explicit effort for a validated manual model selection. */
  reasoningEffort?: ReasoningEffort | undefined;
  latestMessageId: string;
  runId: string;
  parentRunId?: string | undefined;
  resume?: RunAgentResumeItem[] | undefined;
  messages: ChatMessage[];
  owningAssistantMessageId?: SafeId<"chatMessage"> | undefined;
  /**
   * Store the finished turn, and say what its row now holds: the run counts
   * that, not the outcome it proposed.
   */
  onFinish: (event: StreamChatFinishEvent) => Promise<ChatTurnStoredSettlement>;
  /** What the client is shown of the history `messages` came from. */
  storedHistory: StoredHistory;
  organizationId: SafeId<"organization">;
  /** The turn's admission: every model request of the turn carries it. */
  modelAdmission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  /**
   * Explicit per-turn execution mode from the request (`body.runMode`).
   * `"agent"` opts this turn into an agent-sandbox run; undefined (the default
   * for every normal chat) keeps the server-side model path. Gating the
   * sandbox plan on this makes it structurally impossible for a normal/BYOK
   * chat to be rerouted just because the sandbox engine is enabled.
   */
  runMode: ChatRunMode | undefined;
  sandboxRun: StellaSandboxRunInput | undefined;
  /** Budget lane the pre-flight resolved for this turn. */
  usageLane: UsageEventLane;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantToolInputRefs?: AssistantToolInputRefResolver | undefined;
  resolveAssistantToolOutputRefs?: AssistantToolOutputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  /** The turn's run: it owns the abort, the stop and the settlement. */
  run: ChatTurnRun;
  safeDb: SafeDb;
  /** The prompt's cacheable layers, sent verbatim. */
  systemSafe: ChatSafePromptLayers;
  systemUntrusted: ChatUntrustedPromptSuffix;
  /**
   * The org's accessible workspace ids, for the model-ingress guard: the
   * exact tenant set whose raw ids must never reach the provider (only chat
   * refs may). Already loaded on every send, so membership checks are free.
   */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  /**
   * Every tool call id the thread already holds, the turns outside `messages`
   * included, so no call of this run reuses one.
   */
  threadToolCallIds: readonly string[];
  tools: ChatToolMap;
  externalMcpToolSource?: StellaMcpToolSource | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

/** A pre-stream rejection retains its settlement code alongside its HTTP body. */
export class ChatTurnFailureResponse extends Response {
  readonly failureCode: ChatTurnFailureCode;
  readonly retryable: boolean;

  constructor({
    failureCode,
    payload,
    status,
  }: {
    failureCode: ChatTurnFailureCode;
    payload: { code?: string; message: string };
    status: 422 | 500;
  }) {
    super(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
      status,
    });
    this.failureCode = failureCode;
    this.retryable = status >= 500;
  }
}

export const pruneOrphanedToolParts = (
  messages: readonly ChatMessage[],
): ChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    const parts = message.parts.filter((part) => {
      if (part.type !== "tool-call") {
        return true;
      }

      const { state } = part;
      switch (state) {
        case "awaiting-input":
        case "input-streaming":
        case "approval-requested":
          return false;
        case "input-complete":
        case "approval-responded":
        case "complete":
        case "error":
          return true;
        default:
          state satisfies never;
          return panic("Unhandled tool-call state");
      }
    });
    return parts.length === message.parts.length
      ? message
      : { ...message, parts };
  });

export const prepareResumeForThirdParty = async ({
  boundary,
  resume,
}: {
  boundary: ChatThirdPartyBoundary;
  resume: RunAgentResumeItem[] | undefined;
}): Promise<Result<RunAgentResumeItem[] | undefined, AnonymizationRefusal>> => {
  if (resume === undefined || boundary.type === "raw") {
    return Result.ok(resume);
  }

  const resumePayloads: unknown[] = resume.map((item) => {
    const payload: unknown = item.payload;
    return payload;
  });
  const payloads = await prepareUnknownForThirdParty({
    boundary,
    value: resumePayloads,
  });
  if (Result.isError(payloads)) {
    return Result.err(payloads.error);
  }
  const preparedPayloads: unknown = payloads.value;
  if (!Array.isArray(preparedPayloads)) {
    return panic("Resume payload preparation changed the batch shape");
  }
  return Result.ok(
    resume.map((item, index) => {
      if (item.payload === undefined) {
        return item;
      }
      const payload: unknown = preparedPayloads.at(index);
      return { ...item, payload };
    }),
  );
};

export type StreamChatOutcome =
  | { type: "streaming"; response: Response }
  | { type: "refused"; response: ChatTurnFailureResponse };

export const streamChat = async ({
  visualOrigin,
  devModelId,
  latestMessageId,
  runId,
  parentRunId,
  resume,
  messages: rawMessages,
  owningAssistantMessageId,
  onFinish,
  organizationId,
  modelAdmission,
  orgAIConfig,
  managedAIResidency,
  promptCacheKey,
  promptCachingEnabled,
  reasoningEffort,
  runMode,
  sandboxRun,
  usageLane,
  resolveAssistantTextRefs,
  resolveAssistantToolInputRefs,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  run,
  safeDb,
  storedHistory,
  systemSafe,
  systemUntrusted,
  tenantWorkspaceIds,
  thirdPartyBoundary,
  threadId,
  threadToolCallIds,
  tools,
  externalMcpToolSource,
  userId,
  workspaceId,
}: StreamChatProps): Promise<StreamChatOutcome> => {
  const messages = pruneOrphanedToolParts(rawMessages);
  const agentBoundaryError = resolveAgentRunBoundaryError({
    boundary: thirdPartyBoundary,
    runMode,
  });
  if (agentBoundaryError !== null) {
    return {
      type: "refused",
      response: thirdPartyBoundaryRefusalResponse(agentBoundaryError),
    };
  }
  const systemSafeText = chatSafePromptText(systemSafe);
  reserveThirdPartyBoundarySourcePlaceholders({
    boundary: thirdPartyBoundary,
    value: [systemSafeText, systemUntrusted, messages, resume, tools],
  });
  const preparedUntrusted = await prepareTextForThirdParty({
    boundary: thirdPartyBoundary,
    text: systemUntrusted,
  });
  if (Result.isError(preparedUntrusted)) {
    return {
      type: "refused",
      response: thirdPartyBoundaryRefusalResponse(preparedUntrusted.error),
    };
  }
  const system =
    preparedUntrusted.value.length > 0
      ? `${systemSafeText}${preparedUntrusted.value.startsWith("\n") ? "" : "\n\n"}${preparedUntrusted.value}`
      : systemSafeText;
  // The system prompt is entirely server-built; a tenant workspace id in it
  // is a Stella bug (matter scope, active-file, and connected-matter
  // sections must all speak in chat refs), so this fails closed.
  const guardedSystem = guardModelSystemPrompt({
    system,
    workspaceIds: tenantWorkspaceIds,
  });

  const rawPreparedMessages = await prepareMessagesForThirdParty({
    boundary: thirdPartyBoundary,
    messages,
  });
  if (Result.isError(rawPreparedMessages)) {
    return {
      type: "refused",
      response: thirdPartyBoundaryRefusalResponse(rawPreparedMessages.error),
    };
  }
  const preparedResumeResult = await prepareResumeForThirdParty({
    boundary: thirdPartyBoundary,
    resume,
  });
  if (Result.isError(preparedResumeResult)) {
    return {
      type: "refused",
      response: thirdPartyBoundaryRefusalResponse(preparedResumeResult.error),
    };
  }
  const preparedResume = preparedResumeResult.value;
  // Messages carry user-authored and historical text (mention hrefs from
  // before ref hydration covered user text, pasted workspace URLs), so hits
  // are redacted rather than refused: old threads keep working, telemetry
  // counts every residual ingress leak (recording the first 20 paths), and
  // the model loses only an id it could not legitimately use.
  const preparedMessageList = guardModelMessages({
    messages: rawPreparedMessages.value,
    workspaceIds: tenantWorkspaceIds,
  });

  const turnModelSelection = resolveChatTurnModel({
    messages: rawMessages,
    owningAssistantMessageId,
    requestedModelId: devModelId,
    requestedReasoningEffort: reasoningEffort,
    canServe: (modelId) =>
      Result.isOk(validateTanStackDevModelOverride(modelId, orgAIConfig)),
  });
  const primaryModel = await resolveTanStackTextModel({
    dataClass: "customer",
    modelId: turnModelSelection.modelId,
    organizationId,
    admission: modelAdmission,
    orgAIConfig,
    managedAIResidency,
    reasoningEffort: turnModelSelection.reasoningEffort,
    role: "chat",
  });
  run.attributeProvider(primaryModel.provider);

  // Tool schemas are mostly server-built but may include org-configured
  // external MCP tool descriptions, so a hit here is telemetry, not a
  // turn-killing panic (the guard only panics for the system prompt).
  const modelTools = guardModelToolSchemas({
    tools: chatToolMapToArray(
      prepareToolsForThirdParty({ boundary: thirdPartyBoundary, tools }),
    ),
    workspaceIds: tenantWorkspaceIds,
  });

  // Provider adapters accept different document formats: the Mistral adapter
  // takes a PDF `document` part (via `document_url`) but throws on a textual
  // one, and no adapter accepts a raw docx. A document attachment reaches the
  // model as a `document` part, and `resolveEffectiveChatModelId` selects the
  // chat model without gating by modality, so reject here — before dispatch —
  // any document whose format the model cannot ingest, rather than let the
  // adapter crash the stream.
  const documentAttachmentMimeTypes = preparedMessageList.flatMap((message) =>
    message.parts.filter(isChatDocumentPart).map(getChatAttachmentMimeType),
  );
  const modelRejectsAnyDocument = (model: ResolvedTanStackTextModel): boolean =>
    documentAttachmentMimeTypes.some(
      (mimeType) => !modelAcceptsDocumentAttachment({ model, mimeType }),
    );
  const hasImageAttachments = preparedMessageList.some((message) =>
    message.parts.some((part) => part.type === "image"),
  );
  const modelRejectsImages = (model: ResolvedTanStackTextModel): boolean =>
    hasImageAttachments &&
    getModelImageInputCapability(model) === "unsupported";
  const modelRejectsStreamingTools = (
    model: ResolvedTanStackTextModel,
  ): boolean =>
    chatTurnRejectsStreamingTools({ model, toolCount: modelTools.length });

  if (modelRejectsImages(primaryModel)) {
    return {
      type: "refused",
      response: new ChatTurnFailureResponse({
        failureCode: "unsupported-input",
        payload: {
          code: IMAGE_INPUT_UNSUPPORTED_CODE,
          message: imageInputUnsupportedError().message,
        },
        status: 422,
      }),
    };
  }

  if (modelRejectsAnyDocument(primaryModel)) {
    // A plain 422, NOT a third-party-boundary refusal: that code is the sole
    // trigger for the "send without anonymization" retry, which cannot fix a
    // model that simply cannot read the attachment's format.
    return {
      type: "refused",
      response: new ChatTurnFailureResponse({
        failureCode: "unsupported-input",
        payload: {
          message:
            "This model cannot read one of the attached documents. Remove the attachment or switch to a model that supports it.",
        },
        status: 422,
      }),
    };
  }

  if (modelRejectsStreamingTools(primaryModel)) {
    return {
      type: "refused",
      response: new ChatTurnFailureResponse({
        failureCode: "unsupported-input",
        payload: {
          message:
            "This model cannot use tools while streaming, so it cannot answer chat questions about your matter. Switch to a model that supports tool use.",
        },
        status: 422,
      }),
    };
  }

  const resolvedFallbackModel =
    turnModelSelection.fallbackPolicy === "automatic"
      ? await resolveFallbackTextModel({
          organizationId,
          modelAdmission,
          orgAIConfig,
          managedAIResidency,
          primaryModel,
          threadId,
        })
      : null;
  // Drop a fallback that would crash on a document the primary accepted, or
  // that cannot carry this turn's tools; a failover must not resurrect a
  // capability mismatch the primary already cleared.
  const fallbackModel =
    resolvedFallbackModel !== null &&
    (modelRejectsAnyDocument(resolvedFallbackModel) ||
      modelRejectsImages(resolvedFallbackModel) ||
      modelRejectsStreamingTools(resolvedFallbackModel))
      ? null
      : resolvedFallbackModel;
  const { abortController, deadlineSignal } = run.control;
  const restorationPairs: ChatAnonRestoration[] = [];

  let servedTurnModel: ChatTurnModel = {
    provider: primaryModel.provider,
    model: primaryModel.modelId,
    ...(turnModelSelection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: turnModelSelection.reasoningEffort }),
  };
  const attemptStream = runChatAttempts({
    abortController: run.control.providerAbortController,
    abortSignal:
      run.control.admissionSignal === undefined
        ? deadlineSignal
        : AbortSignal.any([deadlineSignal, run.control.admissionSignal]),
    devModelId: turnModelSelection.modelId,
    onModelDispatched: (model) => {
      servedTurnModel = {
        provider: model.provider,
        model: model.modelId,
        ...(turnModelSelection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: turnModelSelection.reasoningEffort }),
      };
    },
    externalMcpToolSource,
    fallbackModel,
    organizationId,
    modelAdmission,
    orgAIConfig,
    managedAIResidency,
    primaryModel,
    promptCacheKey,
    promptCachingEnabled,
    runMode,
    sandboxRun,
    usageLane,
    runId,
    parentRunId,
    resume: preparedResume,
    safeDb,
    surfaces: {
      // The provider's copy only: persistence keeps the stored parts.
      messages: guardProviderHistory({
        messages: preparedMessageList,
        workspaceIds: tenantWorkspaceIds,
      }),
      system: guardedSystem,
      systemLayers: systemSafe,
      tenantWorkspaceIds,
      tools: modelTools,
    },
    thirdPartyBoundary,
    threadId,
    // One ledger for the run: every request of it, a fallback's included.
    toolCallIds: new ToolCallIdLedger(threadToolCallIds),
    userId,
    workspaceId,
  });
  const stream =
    run.control.admissionSignal === undefined
      ? attemptStream
      : (async function* (): AsyncIterable<PublicStreamChunk> {
          if (!run.startContinuationProduction()) {
            return;
          }
          yield* attemptStream;
        })();

  const log = createChatRunLog({
    db: async (callback) => {
      const result = await safeDb(callback);
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    },
    execution: run.execution,
    organizationId,
    runId,
  });
  const settlement: {
    event: StreamChatFinishEvent | undefined;
    source: "not-started" | "started";
    resumeSnapshot: ChatMessageMetadata["resumeSnapshot"];
    terminalChunk: StreamChunk | undefined;
    finished: Promise<unknown> | undefined;
  } = {
    source: "not-started",
    resumeSnapshot: undefined,
    terminalChunk: undefined,
    finished: undefined,
    event: undefined,
  };
  const persistenceVisibleStream = transformPersistenceVisibleStream({
    boundary: thirdPartyBoundary,
    initialRestorationPlaceholders:
      thirdPartyBoundary.type === "anonymized"
        ? collectInitialRestorationPlaceholders({
            latestMessageId,
            messages: preparedMessageList,
            redactionMap: thirdPartyBoundary.redactionMap,
          })
        : new Set<string>(),
    restorationPairs,
    source: projectVisualPreviewStream(stream),
  });
  const processedStream = processTurnForPersistence({
    visualOrigin,
    // Delivery detach does not reach the producer; Stop, ownership and budgets do.
    abortSignal:
      run.control.admissionSignal === undefined
        ? abortController.signal
        : AbortSignal.any([
            abortController.signal,
            run.control.admissionSignal,
          ]),
    ...(run.control.admissionSignal === undefined
      ? {}
      : {
          runSignal: abortController.signal,
          getRestorableCheckpoint: () => run.restorableCheckpoint,
        }),
    deadlineSignal,
    flushPendingSource: persistenceVisibleStream.flushPending,
    initialMessages: preparedMessageList,
    onFinish: (event) => {
      settlement.event = {
        outcome: event.outcome,
        responseMessage: attachTerminalTurnOutcome({
          message: toPersistableChatMessage(
            stampReasoningProvenance({
              message: {
                ...event.responseMessage,
                metadata: {
                  ...event.responseMessage.metadata,
                  turnModel: servedTurnModel,
                },
              },
              model: {
                provider: servedTurnModel.provider,
                modelId: servedTurnModel.model,
              },
              initialMessages: rawMessages,
            }),
          ),
          turnOutcome: event.outcome,
        }),
      };
    },
    owningAssistantMessageId,
    restorationPairs,
    source: persistenceVisibleStream,
  });
  const visibleOutput = transformClientVisibleStream({
    deniedApprovals: findDeniedApprovals(preparedMessageList),
    resolveAssistantTextRefs,
    resolveAssistantToolInputRefs,
    resolveAssistantToolOutputRefs,
    resolveAssistantValueRefs,
    source: processedStream,
    storedHistory,
  });

  const output = (async function* () {
    settlement.source = "started";
    const finalChunks: StreamChunk[] = [];
    for await (const chunk of visibleOutput) {
      if (
        settlement.event !== undefined &&
        (chunk.type === EventType.RUN_FINISHED ||
          chunk.type === EventType.RUN_ERROR)
      ) {
        if (
          chunk.type === EventType.RUN_FINISHED &&
          chunk.outcome?.type === "interrupt"
        ) {
          settlement.resumeSnapshot = {
            resumeState: { threadId, runId },
            pendingInterrupts: chunk.outcome.interrupts,
          };
        }
        finalChunks.push(chunk);
        continue;
      }
      yield chunk;
    }
    // The visual transform can flush buffered refs after the source terminal.
    // Deliver that content before terminalizing, and identify the last terminal
    // so every earlier iteration remains appendable under the execution fence.
    settlement.terminalChunk = finalChunks.at(-1);
    yield* finalChunks;
  })();
  const finishSettlement = async () => {
    const { event } = settlement;
    if (event === undefined) {
      settlement.finished ??= run.failProduction(settlement.source);
      await settlement.finished;
      return;
    }
    const responseMessage =
      event.outcome.type === "awaiting-user" &&
      settlement.resumeSnapshot !== undefined
        ? attachTerminalTurnOutcome({
            message: toPersistableChatMessage({
              ...event.responseMessage,
              metadata: {
                ...event.responseMessage.metadata,
                resumeSnapshot: settlement.resumeSnapshot,
              },
            }),
            turnOutcome: event.outcome,
          })
        : event.responseMessage;
    settlement.finished ??= run.settle(
      async () => await onFinish({ outcome: event.outcome, responseMessage }),
    );
    await settlement.finished;
  };

  return {
    type: "streaming",
    response: run.produce(output, {
      ...log,
      append: async (chunks) => {
        const offsets = await log.append(chunks);
        if (
          settlement.terminalChunk !== undefined &&
          chunks.includes(settlement.terminalChunk)
        ) {
          // Append while fenced; persist the transcript before returning the
          // offsets that allow the SDK to deliver the final terminal event.
          await finishSettlement();
        }
        return offsets;
      },
      close: async () => {
        // A producer cutoff can return its generator without emitting a
        // terminal. The SDK flushes its cleanup batch before this callback.
        await finishSettlement();
        await log.close();
      },
    }),
  };
};

const thirdPartyBoundaryRefusalResponse = (
  error: AnonymizationRefusal,
): ChatTurnFailureResponse =>
  new ChatTurnFailureResponse({
    failureCode: error.failureCode,
    payload: createThirdPartyBoundaryRefusalPayload(error.message),
    status: error.status,
  });

type ResolveAgentRunBoundaryErrorInput = {
  boundary: Pick<ChatThirdPartyBoundary, "type">;
  runMode: ChatRunMode | undefined;
};

export const resolveAgentRunBoundaryError = ({
  boundary,
  runMode,
}: ResolveAgentRunBoundaryErrorInput): AnonymizationRefusal<422> | null => {
  if (
    runMode !== CHAT_RUN_MODE.agent ||
    boundary.type !== CHAT_SEND_MODE.anonymized
  ) {
    return null;
  }

  return refuseAnonymizedCrossing({
    message:
      "Agent sandbox access is not available in anonymized mode because its MCP tools can return raw workspace data.",
    offerRawRetry: true,
    reason: "mode_policy",
    site: "agent_run",
    status: 422,
  });
};

type ChatTurnRejectsStreamingToolsOptions = {
  model: Pick<ResolvedTanStackTextModel, "modelId">;
  toolCount: number;
};

/**
 * Whether this turn would have to offer tools on a stream its model cannot
 * carry them on. An agent turn sends its tool schemas with the streaming
 * request itself, and such a model answers with a fatal stream error.
 * Structured output has a non-streaming path the engine falls back to; a
 * tool-carrying chat stream has none, so the turn is refused rather than
 * stripped of its tools, which would leave the model answering about a
 * matter it can no longer read.
 */
export const chatTurnRejectsStreamingTools = ({
  model,
  toolCount,
}: ChatTurnRejectsStreamingToolsOptions): boolean =>
  toolCount > 0 && !modelAcceptsStreamingToolUse(model);

type ChatAttemptState = {
  emptyCompletion: ChatEmptyCompletionError | null;
  finalLoopDetection: ChatLoopDetectedError | null;
  /** Whether the attempt has streamed an answer (`chunkCarriesAnswer`). */
  producedAnswer: boolean;
};

export const createChatAttemptState = (): ChatAttemptState => ({
  emptyCompletion: null,
  finalLoopDetection: null,
  producedAnswer: false,
});

type ChatAttemptModelInfo = Pick<
  ResolvedTanStackTextModel,
  "modelId" | "provider"
>;

type RecordChatAttemptFinishProps = {
  captureError?: typeof captureError | undefined;
  finishReason: string | null;
  messages: readonly ModelMessage[];
  modelInfo: ChatAttemptModelInfo;
  state: ChatAttemptState;
  threadId: SafeId<"chatThread">;
};

export const recordChatAttemptFinish = ({
  captureError: captureAttemptError = captureError,
  finishReason,
  messages,
  modelInfo,
  state,
  threadId,
}: RecordChatAttemptFinishProps): void => {
  const loopDetection = detectModelLoop(messages);
  if (shouldSurfaceFinalContentLoop(loopDetection)) {
    state.finalLoopDetection = new ChatLoopDetectedError({
      message: CHAT_LOOP_DETECTED_MESSAGE,
    });
  }

  // Emptiness is read from what the attempt streamed, never from the
  // provider's token count: a model can spend completion tokens on an answer
  // that holds nothing. Any other finish reason is left to the terminal
  // guard, which settles the turn without trying the fallback model.
  if (finishReason !== "stop" || state.producedAnswer) {
    return;
  }

  state.emptyCompletion = new ChatEmptyCompletionError({
    message: CHAT_EMPTY_COMPLETION_MESSAGE,
  });
  captureAttemptError(state.emptyCompletion, {
    modelId: modelInfo.modelId,
    provider: modelInfo.provider,
    threadId,
  });
};

const chatAttemptTerminalError = (
  state: ChatAttemptState,
): ChatTerminalError | null =>
  state.finalLoopDetection ?? state.emptyCompletion;

type ShouldAttemptChatFallbackInput = {
  hasFallbackModel: boolean;
  hasNativeContinuation: boolean;
  primaryError: ChatLoopDetectedError | ChatEmptyCompletionError;
  runMode: ChatRunMode | undefined;
};

export const shouldAttemptChatFallback = ({
  hasFallbackModel,
  hasNativeContinuation,
  primaryError,
  runMode,
}: ShouldAttemptChatFallbackInput): boolean =>
  runMode !== CHAT_RUN_MODE.agent &&
  !hasNativeContinuation &&
  primaryError instanceof ChatEmptyCompletionError &&
  hasFallbackModel;
const projectServerToolsForProvider = ({
  provider,
  serverTools,
}: {
  provider: string;
  serverTools: readonly AnyServerTool[];
}): AnyServerTool[] => {
  const projectionOptions = providerSafeJsonSchemaOptionsForTanStackProvider(
    provider,
    "tool",
  );
  const projectedTools: AnyServerTool[] = [];
  for (const tool of serverTools) {
    const projectedTool = { ...tool };
    if (tool.inputSchema !== undefined) {
      const inputSchema = projectSchemaInputJsonSchema(
        tool.inputSchema,
        projectionOptions,
      );
      if (inputSchema !== undefined) {
        projectedTool.inputSchema = inputSchema;
      }
    }
    if (tool.outputSchema !== undefined) {
      const outputSchema = projectSchemaInputJsonSchema(
        tool.outputSchema,
        projectionOptions,
      );
      if (outputSchema !== undefined) {
        projectedTool.outputSchema = outputSchema;
      }
    }
    projectedTools.push(projectedTool);
  }
  return projectedTools;
};

/**
 * The org's MCP connectors serve their tool schemas lazily, so the guard has
 * to sit outside every other wrapper: provider projection and the anonymizer
 * both rewrite what `tools()` returns, and the guard must see what the model
 * finally gets. Returning the branded type keeps an unwrapped source from
 * reaching `chat({ mcp: { clients } })`.
 */
const guardedMcpClients = ({
  boundary,
  provider,
  source,
  tenantWorkspaceIds,
}: {
  boundary: ChatThirdPartyBoundary;
  provider: string;
  source: StellaMcpToolSource;
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
}): GuardedMcpToolSource[] => [
  guardMcpToolSource({
    source: prepareMcpToolSourceForThirdParty({
      boundary,
      source: projectMcpToolSourceSchemasForProvider({ provider, source }),
    }),
    workspaceIds: tenantWorkspaceIds,
  }),
];

const projectMcpToolSourceSchemasForProvider = ({
  provider,
  source,
}: {
  provider: string;
  source: StellaMcpToolSource;
}): StellaMcpToolSource => ({
  close: source.close,
  tools: async (options) =>
    projectServerToolsForProvider({
      provider,
      serverTools: await source.tools(options),
    }),
});

type ResolveFallbackTextModelProps = {
  organizationId: SafeId<"organization">;
  modelAdmission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  primaryModel: ResolvedTanStackTextModel;
  threadId: SafeId<"chatThread">;
};

const resolveFallbackTextModel = async ({
  organizationId,
  modelAdmission,
  orgAIConfig,
  managedAIResidency,
  primaryModel,
  threadId,
}: ResolveFallbackTextModelProps): Promise<ResolvedTanStackTextModel | null> => {
  try {
    const fallbackModel = await resolveTanStackTextModel({
      dataClass: "customer",
      organizationId,
      admission: modelAdmission,
      orgAIConfig,
      managedAIResidency,
      role: "reasoning",
    });
    if (
      fallbackModel.provider === primaryModel.provider &&
      fallbackModel.modelId === primaryModel.modelId
    ) {
      return null;
    }
    return fallbackModel;
  } catch (error) {
    captureError(error, {
      feature: "chat.stream_fallback_resolution",
      threadId,
    });
    return null;
  }
};

type CreateChatAttemptAnalyticsProps = {
  feature: string;
  modelRole: ModelRole;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCacheSurface?: PromptCacheMetricSurface | undefined;
  safeDb: SafeDb;
  /** Explicit per-turn model selection; undefined = role default. */
  selectedModelId: string | undefined;
  /** Budget lane this turn's consumption settles against. */
  usageLane: UsageEventLane;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const createChatAttemptAnalytics = ({
  feature,
  modelRole,
  organizationId,
  orgAIConfig,
  promptCacheSurface,
  safeDb,
  selectedModelId,
  usageLane,
  threadId,
  userId,
  workspaceId,
}: CreateChatAttemptAnalyticsProps): TanStackAIAnalyticsCallbacks =>
  createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    promptCacheSurface,
    usageMetering: {
      actionType: "chat",
      lane: usageLane,
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId,
    },
    feature,
    modelRole,
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
    selectedModelId,
    sessionId: threadId,
    traceId: Bun.randomUUIDv7(),
  });

type ChatAttemptRole = Extract<ModelRole, "chat" | "reasoning">;

/**
 * Every surface this request hands to the provider, each one minted by the
 * model-ingress guard. The chat dispatch accepts only this bundle, so a
 * surface that skipped the guard — or one rebuilt after it ran — cannot reach
 * the model without failing typecheck.
 */
export type GuardedChatSurfaces = {
  /** Minted by `guardProviderHistory`: guarded, with every call answered
   *  right after its step. */
  messages: GuardedProviderHistory;
  system: GuardedSystemPrompt;
  /** The cacheable layers `system` begins with, where its cache markers go
   *  (`chat-request.ts`). */
  systemLayers: ChatSafePromptLayers;
  /**
   * The guard's own input, carried alongside its output because the surfaces
   * are not final: the runtime middleware rewrites messages and system prompt
   * mid-loop (compaction, loop recovery) and has to re-enter the guard with
   * the same tenant set, and the org's MCP source fetches schemas lazily.
   */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  tools: GuardedToolSchemas<ChatTool[]>;
};

type RunChatAttemptsProps = {
  onModelDispatched: (model: ResolvedTanStackTextModel) => void;
  abortController: AbortController;
  abortSignal: AbortSignal;
  devModelId: string | undefined;
  externalMcpToolSource: StellaMcpToolSource | undefined;
  fallbackModel: ResolvedTanStackTextModel | null;
  organizationId: SafeId<"organization">;
  modelAdmission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  primaryModel: ResolvedTanStackTextModel;
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  runMode: ChatRunMode | undefined;
  sandboxRun: StellaSandboxRunInput | undefined;
  /** Budget lane the pre-flight resolved for this turn. */
  usageLane: UsageEventLane;
  runId: string;
  parentRunId: string | undefined;
  resume: RunAgentResumeItem[] | undefined;
  safeDb: SafeDb;
  surfaces: GuardedChatSurfaces;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  toolCallIds: ToolCallIdLedger;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const runChatAttempts = async function* ({
  abortController,
  abortSignal,
  devModelId,
  onModelDispatched,
  externalMcpToolSource,
  fallbackModel,
  organizationId,
  modelAdmission,
  orgAIConfig,
  managedAIResidency,
  primaryModel,
  promptCacheKey,
  promptCachingEnabled,
  runMode,
  sandboxRun,
  usageLane,
  runId,
  parentRunId,
  resume,
  safeDb,
  surfaces,
  thirdPartyBoundary,
  threadId,
  toolCallIds,
  userId,
  workspaceId,
}: RunChatAttemptsProps): AsyncIterable<PublicStreamChunk> {
  const primaryState = createChatAttemptState();
  // The caller resolves an explicit agent sandbox before persisting the
  // incoming message. A normal chat never carries a plan, even when the engine
  // is enabled, so BYOK/model-selected turns keep the chosen adapter.
  onModelDispatched(primaryModel);
  yield* runChatAttempt({
    abortController,
    abortSignal,
    compactionFeature: "chat.step_compaction",
    externalMcpToolSource,
    feature: "chat.stream",
    model: primaryModel,
    modelId: devModelId,
    organizationId,
    modelAdmission,
    orgAIConfig,
    managedAIResidency,
    promptCacheKey,
    promptCachingEnabled,
    runId,
    parentRunId,
    resume,
    role: "chat",
    safeDb,
    sandboxRun,
    usageLane,
    state: primaryState,
    surfaces,
    thirdPartyBoundary,
    threadId,
    toolCallIds,
    userId,
    workspaceId,
  });

  const primaryError = chatAttemptTerminalError(primaryState);
  if (primaryError === null) {
    return;
  }

  if (
    !shouldAttemptChatFallback({
      hasFallbackModel: fallbackModel !== null,
      hasNativeContinuation: resume !== undefined,
      primaryError,
      runMode,
    })
  ) {
    // An explicit sandbox request must never cross execution or credential
    // boundaries by falling back to the ordinary server-side model.
    throw primaryError;
  }

  if (fallbackModel === null) {
    panic("Fallback model disappeared after fallback eligibility check");
  }

  const fallbackState = createChatAttemptState();
  onModelDispatched(fallbackModel);
  yield* runChatAttempt({
    abortController,
    abortSignal,
    compactionFeature: "chat.step_compaction_fallback",
    externalMcpToolSource,
    feature: "chat.stream_fallback",
    model: fallbackModel,
    modelId: undefined,
    organizationId,
    modelAdmission,
    orgAIConfig,
    managedAIResidency,
    promptCacheKey,
    promptCachingEnabled,
    role: "reasoning",
    safeDb,
    // The provider-fallback attempt serves the same user turn, so it
    // settles against the same budget lane.
    usageLane,
    state: fallbackState,
    surfaces,
    thirdPartyBoundary,
    threadId,
    toolCallIds,
    userId,
    workspaceId,
  });

  const fallbackError = chatAttemptTerminalError(fallbackState);
  if (fallbackError !== null) {
    throw fallbackError;
  }
};

type RunChatAttemptProps = {
  abortController: AbortController;
  abortSignal: AbortSignal;
  compactionFeature: string;
  /** Budget lane this turn's consumption settles against. */
  usageLane: UsageEventLane;
  externalMcpToolSource: StellaMcpToolSource | undefined;
  feature: string;
  model: ResolvedTanStackTextModel;
  modelId: string | undefined;
  organizationId: SafeId<"organization">;
  modelAdmission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  runId?: string | undefined;
  parentRunId?: string | undefined;
  resume?: RunAgentResumeItem[] | undefined;
  role: ChatAttemptRole;
  safeDb: SafeDb;
  /**
   * When set, this attempt runs inside an agent sandbox: the
   * harness adapter replaces the model adapter and the sandbox middleware is
   * added. When absent (the default for every normal chat), the attempt is
   * unchanged. Explicit agent runs never fall back to a plain server-side
   * model attempt.
   */
  sandboxRun?: StellaSandboxRunInput | undefined;
  state: ChatAttemptState;
  surfaces: GuardedChatSurfaces;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  toolCallIds: ToolCallIdLedger;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const runChatAttempt = async function* ({
  abortController,
  abortSignal,
  compactionFeature,
  externalMcpToolSource,
  feature,
  model,
  modelId,
  organizationId,
  modelAdmission,
  orgAIConfig,
  managedAIResidency,
  promptCacheKey,
  promptCachingEnabled,
  runId,
  parentRunId,
  resume,
  role,
  safeDb,
  sandboxRun,
  usageLane,
  state,
  surfaces,
  thirdPartyBoundary,
  threadId,
  toolCallIds,
  userId,
  workspaceId,
}: RunChatAttemptProps): AsyncIterable<PublicStreamChunk> {
  // The one place the guard's brands are widened back to the plain types the
  // provider SDK takes: everything below this line is dispatch.
  const {
    messages: preparedMessages,
    system: baseSystem,
    systemLayers,
    tenantWorkspaceIds,
    tools: modelTools,
  } = surfaces;
  const caching = resolveCaching({
    promptCachingEnabled,
    role,
    scopeKey: promptCacheKey,
  });
  // Sandbox turns dispatch on the harness's own model, not the thread's
  // selection, so their consumption must rate against the role default
  // rather than a model that never served them.
  const servedModelId = sandboxRun ? undefined : modelId;
  // Sandbox turns are machine work: they settle against the pool
  // regardless of the interactive lane the pre-flight resolved.
  const servedLane = sandboxRun ? "pool" : usageLane;
  const analytics = createChatAttemptAnalytics({
    feature,
    modelRole: role,
    organizationId,
    orgAIConfig,
    // The turn's own model calls; compaction below builds another prompt.
    promptCacheSurface: sandboxRun ? undefined : "chat",
    safeDb,
    selectedModelId: servedModelId,
    usageLane: servedLane,
    threadId,
    userId,
    workspaceId,
  });
  const compactionAnalytics = createChatAttemptAnalytics({
    feature: compactionFeature,
    modelRole: role,
    organizationId,
    orgAIConfig,
    safeDb,
    // Compaction runs on the same adapter as the turn itself, so its
    // consumption rates against the same selection.
    selectedModelId: servedModelId,
    usageLane: servedLane,
    threadId,
    userId,
    workspaceId,
  });

  if (sandboxRun) {
    // The harness adapter drives the sandbox run and
    // reaches stella tools only through the bridged MCP server in the sandbox
    // workspace, so `tools`/`mcp` are intentionally not passed here — the
    // bridge is the sole tool surface. The analytics + runtime middleware are
    // shared with the normal path; the sandbox middleware provides the
    // capability the harness adapter requires.
    //
    // `systemPromptsPatch(... baseSystem)` is likewise intentionally omitted:
    // the harness's instruction surface is the workspace AGENTS.md
    // (`sandbox.instructions`), not the chat `system` message. The base chat
    // persona is written for the server-side chat model and its tool surface,
    // so injecting it verbatim into a coding-agent harness would be wrong.
    // `baseSystem` stays wired below for loop-recovery parity.
    const { adapter, middleware: sandboxMiddleware } =
      resolveStellaSandboxRun(sandboxRun);
    yield* streamChatChunks({
      adapter: withRunToolCallIds(
        withProviderStreamContract(adapter),
        toolCallIds,
      ),
      messages: preparedMessages,
      agentLoopStrategy: maxIterations(MAX_TOOL_STEPS),
      abortController,
      threadId,
      ...(runId === undefined ? {} : { runId }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(resume === undefined ? {} : { resume }),
      middleware: [
        analytics.middleware,
        createChatRuntimeMiddleware({
          abortSignal,
          baseSystem,
          caching,
          compactionAnalytics,
          compactionFeature,
          model,
          modelId,
          organizationId,
          modelAdmission,
          orgAIConfig,
          managedAIResidency,
          role,
          state,
          systemLayers,
          tenantWorkspaceIds,
          threadId,
        }),
        sandboxMiddleware,
      ],
    });
    return;
  }

  const stream = streamChatChunks({
    ...chatAttemptRequestOptions({
      caching,
      model,
      modelTools,
      role,
      system: baseSystem,
      systemLayers,
      toolCallIds,
    }),
    messages: preparedMessages,
    ...(externalMcpToolSource
      ? {
          mcp: {
            clients: guardedMcpClients({
              boundary: thirdPartyBoundary,
              provider: model.provider,
              source: externalMcpToolSource,
              tenantWorkspaceIds,
            }),
            connection: "close",
            lazyTools: true,
          },
        }
      : {}),
    agentLoopStrategy: maxIterations(MAX_TOOL_STEPS),
    abortController,
    threadId,
    ...(runId === undefined ? {} : { runId }),
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(resume === undefined ? {} : { resume }),
    middleware: [
      analytics.middleware,
      createChatRuntimeMiddleware({
        abortSignal,
        baseSystem,
        caching,
        compactionAnalytics,
        compactionFeature,
        model,
        modelId,
        organizationId,
        modelAdmission,
        orgAIConfig,
        managedAIResidency,
        role,
        state,
        systemLayers,
        tenantWorkspaceIds,
        threadId,
      }),
    ],
  });

  yield* stream;
};

/**
 * The runtime middleware rewrites the two surfaces the guard already cleared,
 * mid-loop and after dispatch, so both rewrites re-enter it here.
 *
 * The loop-recovery prompt is rebuilt from the already-guarded base prompt
 * plus a signal line naming the looping tool. For an org MCP connector that
 * name is org-authored text — the tool-schema trust class — so a hit is
 * redacted and reported instead of killing the turn.
 */
export const guardedLoopRecoveryPrompts = ({
  baseSystem,
  detection,
  tenantWorkspaceIds,
}: {
  baseSystem: GuardedSystemPrompt;
  detection: Parameters<typeof createLoopRecoverySystemPrompt>[0]["detection"];
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
}): GuardedSystemPrompt[] => [
  redactModelSystemPrompt({
    system: createLoopRecoverySystemPrompt({ baseSystem, detection }),
    workspaceIds: tenantWorkspaceIds,
  }),
];

/**
 * Compaction replaces history with a model-written summary, text that never
 * passed the ingress guard, so the replacement is re-guarded (redact mode, as
 * for any model-authored surface). Returns undefined when compaction left the
 * history alone: an unchanged array is already the guarded one.
 */
export const guardedCompactedMessages = ({
  compacted,
  previous,
  tenantWorkspaceIds,
}: {
  compacted: ModelMessage[];
  previous: readonly ModelMessage[];
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
}): GuardedModelMessages<ModelMessage[]> | undefined =>
  compacted === previous
    ? undefined
    : guardModelMessages({
        messages: compacted,
        workspaceIds: tenantWorkspaceIds,
      });

type ChatRuntimeMiddlewareProps = {
  abortSignal: AbortSignal;
  baseSystem: GuardedSystemPrompt;
  caching: CachingDecision;
  compactionAnalytics: TanStackAIAnalyticsCallbacks;
  compactionFeature: string;
  model: ResolvedTanStackTextModel;
  modelId: string | undefined;
  organizationId: SafeId<"organization">;
  modelAdmission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  role: ChatAttemptRole;
  state: ChatAttemptState;
  systemLayers: ChatSafePromptLayers;
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  threadId: SafeId<"chatThread">;
};

const createChatRuntimeMiddleware = ({
  abortSignal,
  baseSystem,
  caching,
  compactionAnalytics,
  compactionFeature,
  model,
  modelId,
  organizationId,
  modelAdmission,
  orgAIConfig,
  managedAIResidency,
  role,
  state,
  systemLayers,
  tenantWorkspaceIds,
  threadId,
}: ChatRuntimeMiddlewareProps): ChatMiddleware => {
  let lastLoopRecoveryKey: string | null = null;
  const terminalHooks = createTanStackTerminalHooks((event) => {
    switch (event.type) {
      case "completed":
        recordChatAttemptFinish({
          finishReason: event.info.finishReason,
          messages: event.context.messages,
          modelInfo: model,
          state,
          threadId,
        });
        return;
      case "aborted":
      case "failed":
        return;
      default:
        event satisfies never;
        panic(`Unhandled event: ${String(event)}`);
    }
  });
  return {
    name: "stella-chat-runtime",
    ...terminalHooks,
    onChunk: (_ctx, chunk) => {
      state.producedAnswer ||= chunkCarriesAnswer(chunk);
    },
    onConfig: async (ctx, config) => {
      if (ctx.phase !== "beforeModel") {
        return undefined;
      }

      const patch: Partial<ChatMiddlewareConfig> = {};
      const loopDetection = detectModelLoop(config.messages);
      if (shouldStopLoopRecovery(loopDetection)) {
        throw new ChatLoopDetectedError({
          message: CHAT_LOOP_DETECTED_MESSAGE,
        });
      }

      if (shouldInjectLoopRecovery(loopDetection)) {
        const recoveryKey = getLoopRecoveryKey(loopDetection);
        if (recoveryKey !== lastLoopRecoveryKey) {
          lastLoopRecoveryKey = recoveryKey;
          const [recoverySystem] = guardedLoopRecoveryPrompts({
            baseSystem,
            detection: loopDetection,
            tenantWorkspaceIds,
          });
          // The recovery section joins the turn layer, so the cached layers
          // before it keep their markers.
          patch.systemPrompts = chatSystemPrompts({
            caching,
            model,
            system: recoverySystem ?? baseSystem,
            systemLayers,
          });
        }
      }

      const compactedMessages = await compactModelMessagesForModel({
        abortSignal,
        aiAnalytics: compactionAnalytics,
        messages: config.messages,
        modelId,
        organizationId,
        admission: modelAdmission,
        orgAIConfig,
        managedAIResidency,
        role,
        tenantWorkspaceIds,
        onSummaryError: (error) => {
          captureError(error, {
            feature: compactionFeature,
            modelId: model.modelId,
            provider: model.provider,
            threadId,
          });
        },
      });
      if (Result.isError(compactedMessages)) {
        throw compactedMessages.error;
      }

      const guardedCompaction = guardedCompactedMessages({
        compacted: compactedMessages.value,
        previous: config.messages,
        tenantWorkspaceIds,
      });
      if (guardedCompaction !== undefined) {
        patch.messages = guardedCompaction;
      }
      const sortedToolJson = sortToolJsonKeys(
        patch.messages ?? config.messages,
      );
      if (sortedToolJson !== undefined) {
        patch.messages = sortedToolJson;
      }

      return Object.keys(patch).length === 0 ? undefined : patch;
    },
  };
};

type ProcessServerChatStreamProps = {
  /** The run's own signal: aborted by the provider deadline below *and* by the
   *  response stream's cancel, which is how a client disconnect arrives. */
  abortSignal: AbortSignal;
  /** Original run control keeps user-stop and ownership-loss precedence. */
  runSignal?: AbortSignal;
  getRestorableCheckpoint?:
    | (() => PersistableChatMessage | undefined)
    | undefined;
  /** The metered provider deadline the caller set for this turn. It is the
   *  only one of the two causes that reaches this signal, so it is what tells
   *  a deadline apart from a disconnect. */
  deadlineSignal: AbortSignal;
  flushPendingSource?: (() => PublicStreamChunk[]) | undefined;
  getResponseMessage: () => ChatMessage | null;
  visualOrigin?: Pick<VisualResourceOrigin, "accepts"> | undefined;
  /** The history the run starts from: the messages it may continue. */
  initialMessages: readonly ChatMessage[];
  mapMessageId: MessageIdMapper;
  onFinish: (event: StreamChatFinishEvent) => Promise<void> | void;
  processor: ChatStreamProcessor;
  source: AsyncIterable<PublicStreamChunk>;
};

/**
 * Which abort cut this run. A stop aborts the run's controller with
 * upstream's explicit-cancel reason, and a run that no longer owns its turn
 * with its own owner-lost reason. The deadline fires on its own timer and
 * reaches the controller through the signal it derives from, so the deadline
 * itself has to be asked. Any other abort is the response stream's cancel,
 * which is how a dropped connection arrives.
 */
const chatCutShortOutcome = ({
  abortSignal,
  deadlineSignal,
}: {
  abortSignal: AbortSignal;
  deadlineSignal: AbortSignal;
}): CutShortOutcome => {
  if (abortSignal.reason === RUN_CANCEL_REASON) {
    return USER_STOP_OUTCOME;
  }
  if (abortSignal.reason === CHAT_TURN_OWNER_LOST_REASON) {
    return OWNER_LOST_OUTCOME;
  }
  return {
    type: "interrupted",
    reason: deadlineSignal.aborted ? "timeout" : "client-disconnected",
  };
};

type RunErrorChunk = Extract<PublicStreamChunk, { type: EventType.RUN_ERROR }>;

const runErrorMessage = (chunk: RunErrorChunk): string =>
  chunk.message || "AI stream error";

const errorFromRunErrorChunk = (
  chunk: RunErrorChunk,
  cause?: unknown,
): Error => {
  const error =
    cause === undefined
      ? new Error(runErrorMessage(chunk))
      : new Error(runErrorMessage(chunk), { cause });
  const code = chunk.code;
  if (code !== undefined) {
    Object.assign(error, { code });
  }
  return error;
};

const providerDetailFromRunErrorChunk = (chunk: RunErrorChunk): unknown => {
  const rawEvent: unknown = chunk.rawEvent;
  return rawEvent ?? providerErrorBody(runErrorMessage(chunk));
};

const errorForRunErrorChunk = (chunk: RunErrorChunk): unknown =>
  providerDetailFromRunErrorChunk(chunk) ?? errorFromRunErrorChunk(chunk);

export const classifyRunErrorChunk = (chunk: RunErrorChunk): AIErrorKind => {
  const providerDetail = providerDetailFromRunErrorChunk(chunk);
  // Keep the stream's code on the outer error and the structured provider
  // body as its cause. The classifier understands both shapes and walks the
  // cause; choosing either one would discard evidence the adapter preserved.
  // Reporting still receives the original provider detail above, so this
  // synthetic wrapper cannot replace its established telemetry fingerprint.
  return classifyAIError(errorFromRunErrorChunk(chunk, providerDetail));
};

// Classified kinds (quota, billing, retired model, provider outage) are
// expected operational states, and so is a sub-500 `HandlerError` this
// service raised for a configuration state the caller can act on; only an
// unanticipated shape is logged at ERROR severity and reported as a defect.
// Fingerprint only — provider error messages can echo request content.
const reportStreamFailure = (
  error: unknown,
  kind: AIErrorKind,
  providerMessage?: string,
): void => {
  if (isAnticipatedAIFailure(error, kind)) {
    return;
  }
  classifyRejectedProviderRequest(error, kind);
  captureError(error, { kind });
  logger.error("chat.stream_failed", {
    kind,
    ...errorFingerprint(error),
    ...providerStatusFields(error),
    // Structural fields only (code, param, type), never the body's message.
    ...providerErrorFields(error),
    // The template name only; the message itself can echo request content.
    ...(providerMessage === undefined
      ? {}
      : { "error.provider.reason": providerErrorReason(providerMessage) }),
  });
};

const normalizeRunErrorChunk = (chunk: RunErrorChunk): RunErrorChunk => {
  const error = errorForRunErrorChunk(chunk);
  const kind = classifyRunErrorChunk(chunk);
  reportStreamFailure(error, kind, chunk.message);
  const usage = safeTokenUsageFromTerminalChunk(chunk);
  return {
    type: EventType.RUN_ERROR,
    ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
    message: kind,
    code: kind,
    ...(usage === undefined ? {} : { usage }),
  };
};

type AwaitingInteraction = Extract<
  ChatTurnOutcome,
  { type: "awaiting-user" }
>["interaction"];

const awaitsCompleteInput = (interaction: AwaitingInteraction): boolean => {
  switch (interaction.type) {
    case "approval":
      return false;
    case "ask-user":
    case "client-tool":
      return true;
    default:
      interaction satisfies never;
      return panic(`Unhandled interaction: ${String(interaction)}`);
  }
};

const trackIncompleteToolCallInput = (
  chunk: PublicStreamChunk,
  rawArgumentsByToolCallId: Map<string, string>,
): void => {
  if (chunk.type === EventType.TOOL_CALL_START) {
    if (!rawArgumentsByToolCallId.has(chunk.toolCallId)) {
      rawArgumentsByToolCallId.set(chunk.toolCallId, "");
    }
    return;
  }
  if (chunk.type === EventType.TOOL_CALL_ARGS) {
    rawArgumentsByToolCallId.set(
      chunk.toolCallId,
      (rawArgumentsByToolCallId.get(chunk.toolCallId) ?? "") + chunk.delta,
    );
    return;
  }
  if (chunk.type === EventType.TOOL_CALL_END) {
    rawArgumentsByToolCallId.delete(chunk.toolCallId);
  }
};

const restoreInterruptedToolCallInputs = (
  message: ChatMessage | null,
  rawArgumentsByToolCallId: ReadonlyMap<string, string>,
): ChatMessage | null => {
  if (message === null || rawArgumentsByToolCallId.size === 0) {
    return message;
  }
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool-call") {
        return part;
      }
      const argumentsText = rawArgumentsByToolCallId.get(part.id);
      if (argumentsText === undefined) {
        return part;
      }
      const metadata = "metadata" in part ? part.metadata : undefined;
      const candidate: unknown = {
        arguments: argumentsText,
        id: part.id,
        ...(metadata === undefined ? {} : { metadata }),
        name: part.name,
        state:
          argumentsText.length === 0 ? "awaiting-input" : "input-streaming",
        type: "tool-call",
      };
      if (!isChatPart(candidate) || candidate.type !== "tool-call") {
        return panic("Interrupted tool call cannot be restored");
      }
      return candidate;
    }),
  };
};

const isRunFinishedOutcome = (
  lifecycle: ReturnType<typeof tanStackStreamEventLifecycle>,
): boolean => {
  switch (lifecycle) {
    case "completed":
    case "waiting":
    case "cancelled":
      return true;
    case "content":
    case "failed":
    case "started":
      return false;
    default:
      lifecycle satisfies never;
      return panic(`Unhandled TanStack stream lifecycle: ${String(lifecycle)}`);
  }
};

/** The calls bound to the interrupts a run handed out with its final
 *  finish. */
const interruptToolCallIdsOf = (
  chunks: readonly PublicStreamChunk[],
): ReadonlySet<string> =>
  new Set(
    chunks.flatMap((chunk) =>
      chunk.type === EventType.RUN_FINISHED &&
      chunk.outcome?.type === "interrupt"
        ? chunk.outcome.interrupts.flatMap(({ toolCallId }) =>
            toolCallId === undefined ? [] : [toolCallId],
          )
        : [],
    ),
  );

/**
 * How a run whose source drained ended. A cut run that handed out no
 * interaction is cut short; a client-resolved call whose input never finished
 * (no TOOL_CALL_END) cannot be answered by any client, so the turn fails
 * instead of waiting.
 */
const drainedRunOutcome = ({
  abortSignal,
  deadlineSignal,
  finalRunFinishedChunks,
  responseMessage,
  runCancelled,
  toolCallsWithCompleteInput,
}: {
  abortSignal: AbortSignal;
  deadlineSignal: AbortSignal;
  finalRunFinishedChunks: readonly PublicStreamChunk[];
  responseMessage: ChatMessage | null;
  runCancelled: boolean;
  toolCallsWithCompleteInput: ReadonlySet<string>;
}): ChatTurnOutcome => {
  const awaitingUserInteraction = findHandedOutInteraction({
    interruptToolCallIds: interruptToolCallIdsOf(finalRunFinishedChunks),
    message: responseMessage,
  });
  if (
    (abortSignal.aborted || runCancelled) &&
    awaitingUserInteraction === null
  ) {
    // A cancelled run drains like a finished one. TanStack's agent loop
    // checks its cancellation before it reads each adapter chunk, so the
    // terminal `RUN_ERROR` the adapter yields for the aborted provider
    // request is dropped rather than forwarded, and this generator sees a
    // source that simply ended. Grading that silence as a completion
    // persists a turn with no answer and no reason; the signal is what says
    // the turn was cut, and which signal says why. A finish whose outcome is
    // `cancelled` says the same.
    return chatCutShortOutcome({ abortSignal, deadlineSignal });
  }
  const openInteraction = getAwaitingUserInteraction(responseMessage);
  if (
    openInteraction !== null &&
    awaitsCompleteInput(openInteraction) &&
    !toolCallsWithCompleteInput.has(openInteraction.toolCallId)
  ) {
    return { type: "failed", error: "unknown" };
  }
  if (awaitingUserInteraction !== null) {
    return { type: "awaiting-user", interaction: awaitingUserInteraction };
  }
  return { type: "completed" };
};

type AdmissionLossOutcomeOptions = Pick<
  ProcessServerChatStreamProps,
  "getRestorableCheckpoint" | "getResponseMessage" | "processor"
> & {
  deferredRunFinishedChunks: readonly PublicStreamChunk[];
  /** Whether the run streamed an answer (see `processServerChatStream`). */
  producedAnswer: boolean;
  toolCallsWithCompleteInput: ReadonlySet<string>;
};

const resolveAdmissionLossOutcome = ({
  deferredRunFinishedChunks,
  getRestorableCheckpoint,
  getResponseMessage,
  processor,
  producedAnswer,
  toolCallsWithCompleteInput,
}: AdmissionLossOutcomeOptions): ChatTurnOutcome => {
  const originalInteraction = getAwaitingUserInteraction(
    getRestorableCheckpoint?.() ?? null,
  );
  if (originalInteraction !== null) {
    return { type: "awaiting-user", interaction: originalInteraction };
  }
  const handedOut = interruptToolCallIdsOf(deferredRunFinishedChunks);
  for (const chunk of deferredRunFinishedChunks) {
    processor.processChunk(chunk);
  }
  finalizeResponseProcessor(processor);
  const interaction = getAwaitingUserInteractions(getResponseMessage()).find(
    (candidate) =>
      toolCallsWithCompleteInput.has(candidate.toolCallId) &&
      (candidate.type === "approval" || handedOut.has(candidate.toolCallId)),
  );
  if (interaction !== undefined) {
    return { type: "awaiting-user", interaction };
  }
  const lastFinish = deferredRunFinishedChunks.at(-1);
  const response = getResponseMessage();
  // Provider success can precede deferred consumption and connector cleanup.
  // A tool-call finish still needs another iteration and cannot prove completion.
  if (
    lastFinish?.type === EventType.RUN_FINISHED &&
    tanStackStreamEventLifecycle(lastFinish) === "completed" &&
    finishReasonOf(lastFinish) !== "tool_calls" &&
    getAwaitingUserInteraction(response) === null
  ) {
    return producedAnswer
      ? { type: "completed" }
      : { type: "failed", error: "empty_completion" };
  }
  return { type: "failed", error: "provider_unavailable" };
};

const streamControlSignal = (
  abortSignal: AbortSignal,
  runSignal: AbortSignal,
) =>
  runSignal.reason === RUN_CANCEL_REASON ||
  runSignal.reason === CHAT_TURN_OWNER_LOST_REASON
    ? runSignal
    : abortSignal;

type StreamSettlementOptions = Pick<
  ProcessServerChatStreamProps,
  | "abortSignal"
  | "deadlineSignal"
  | "flushPendingSource"
  | "getRestorableCheckpoint"
  | "getResponseMessage"
  | "mapMessageId"
  | "onFinish"
  | "processor"
> & {
  runSignal: AbortSignal;
  deferredRunFinishedChunks: PublicStreamChunk[];
  rawArgumentsByIncompleteToolCallId: Map<string, string>;
  toolCallsWithCompleteInput: Set<string>;
  getUsage: () => TokenUsage | undefined;
  announceBeforeFailure: () => StreamChunk[];
  /** Whether the run streamed an answer (see `processServerChatStream`). */
  getProducedAnswer: () => boolean;
  terminal: { state: "open" | "settled" };
};

const createStreamSettlement = ({
  abortSignal,
  runSignal,
  deadlineSignal,
  flushPendingSource,
  getRestorableCheckpoint,
  getResponseMessage,
  mapMessageId,
  onFinish,
  processor,
  deferredRunFinishedChunks,
  rawArgumentsByIncompleteToolCallId,
  toolCallsWithCompleteInput,
  getUsage,
  getProducedAnswer,
  announceBeforeFailure,
  terminal,
}: StreamSettlementOptions) => {
  const admissionLost = () =>
    ActionAdmissionError.is(abortSignal.reason) &&
    runSignal.reason !== RUN_CANCEL_REASON &&
    runSignal.reason !== CHAT_TURN_OWNER_LOST_REASON;
  const admissionCutByControl = () =>
    ActionAdmissionError.is(abortSignal.reason) &&
    (runSignal.reason === RUN_CANCEL_REASON ||
      runSignal.reason === CHAT_TURN_OWNER_LOST_REASON);
  const cutShortOutcome = () =>
    chatCutShortOutcome({
      abortSignal: streamControlSignal(abortSignal, runSignal),
      deadlineSignal,
    });
  const admissionLossOutcome = (): ChatTurnOutcome => {
    const outcome = resolveAdmissionLossOutcome({
      deferredRunFinishedChunks,
      getRestorableCheckpoint,
      getResponseMessage,
      processor,
      producedAnswer: getProducedAnswer(),
      toolCallsWithCompleteInput,
    });
    if (
      outcome.type !== "failed" ||
      outcome.error === "empty_completion" ||
      !ActionAdmissionError.is(abortSignal.reason)
    ) {
      return outcome;
    }
    return {
      type: "failed",
      error: outcome.error,
      refusal: actionAdmissionRefusal(abortSignal.reason),
    };
  };
  const terminalize = async ({
    flushProcessor = false,
    outcome,
  }: {
    flushProcessor?: boolean;
    outcome: ChatTurnOutcome;
  }): Promise<void> => {
    if (terminal.state === "settled") {
      return;
    }
    if (CUT_SHORT_OUTCOME[outcome.type] && flushPendingSource !== undefined) {
      for (const chunk of flushPendingSource()) {
        trackIncompleteToolCallInput(chunk, rawArgumentsByIncompleteToolCallId);
        processor.processChunk(chunk);
      }
    }
    if (flushProcessor) {
      finalizeResponseProcessor(processor);
    }
    // An empty completion is a provider outcome: the model streamed no
    // answer. A run that streamed one cannot be one; losing that answer
    // between the stream and the persistence processor is a defect in this
    // pipeline, so it must not be graded as an anticipated provider state.
    if (
      (outcome.type === "completed" || outcome.type === "awaiting-user") &&
      getProducedAnswer() &&
      (getResponseMessage()?.parts.length ?? 0) === 0
    ) {
      panic(
        "Persistence processor dropped an assistant turn that streamed an answer",
      );
    }
    const responseMessage = CUT_SHORT_OUTCOME[outcome.type]
      ? restoreInterruptedToolCallInputs(
          getResponseMessage(),
          rawArgumentsByIncompleteToolCallId,
        )
      : getResponseMessage();
    const checkpoint = admissionLost()
      ? getRestorableCheckpoint?.()
      : undefined;
    const terminalResponseMessage =
      checkpoint === undefined
        ? createTerminalResponseMessage({
            mapMessageId,
            outcome,
            producedAnswer: getProducedAnswer(),
            responseMessage,
            usage: getUsage(),
          })
        : attachTerminalTurnOutcome({
            message: checkpoint,
            turnOutcome: outcome,
          });
    terminal.state = "settled";
    await onFinish({ outcome, responseMessage: terminalResponseMessage });
  };
  const admissionFailureChunks = function* (
    outcome: ChatTurnOutcome,
  ): Generator<PublicStreamChunk> {
    if (outcome.type !== "failed" || outcome.refusal === undefined) {
      return;
    }
    const refusal = outcome.refusal;
    yield* announceBeforeFailure();
    yield {
      type: EventType.RUN_ERROR,
      code: refusal.code,
      message: refusal.message,
      rawEvent: refusal,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    };
  };
  return {
    admissionLost,
    admissionCutByControl,
    cutShortOutcome,
    admissionLossOutcome,
    admissionFailureChunks,
    terminalize,
  };
};

type ProcessPersistenceChunkOptions = {
  sourceChunk: PublicStreamChunk;
  deferredRunFinishedChunks: PublicStreamChunk[];
  processor: ChatStreamProcessor;
  runState: { cancelled: boolean };
  recordUsage: (usage: TokenUsage | undefined) => void;
};

type PersistenceChunkResult =
  | { type: "deferred" }
  | { type: "iteration"; chunks: PublicStreamChunk[] }
  | {
      type: "chunk";
      chunk: PublicStreamChunk;
      lifecycle: ReturnType<typeof tanStackStreamEventLifecycle>;
    };

const processPersistenceChunk = ({
  sourceChunk,
  deferredRunFinishedChunks,
  processor,
  runState,
  recordUsage,
}: ProcessPersistenceChunkOptions): PersistenceChunkResult => {
  if (
    sourceChunk.type === EventType.RUN_STARTED &&
    deferredRunFinishedChunks.length > 0
  ) {
    // A later run in the same turn. The client always receives the
    // canonical FINISH(A), START(B) order; what the persistence processor
    // sees depends on whether B is a new run or another iteration of A.
    //
    // TanStack reuses one runId across the model iterations of a request
    // (server tool executed, model called again). An intermediate finish
    // with that same id would empty the processor's active-run set,
    // finalize the shared assistant message, and leave a tool-only B (no
    // TEXT_MESSAGE_START to reactivate it) appended to an inactive message
    // that `onStreamEnd` never reports: the client-tool call is visible
    // live but missing from the persisted turn. An intermediate finish
    // never carries an interrupt (an interrupt ends the run), so the
    // processor loses nothing by seeing only the terminal finish.
    //
    // A run with a different id (a fallback model attempt) must close the
    // prior run for the processor, but only after B is registered, so the
    // shared assistant message stays active across the attempts.
    const priorRunFinishedChunks = deferredRunFinishedChunks.splice(0);
    const isSameRunIteration = priorRunFinishedChunks.every(
      (chunk) =>
        chunk.type === EventType.RUN_FINISHED &&
        chunk.runId === sourceChunk.runId,
    );
    processor.processChunk(sourceChunk);
    if (!isSameRunIteration) {
      for (const chunk of priorRunFinishedChunks) {
        processor.processChunk(chunk);
      }
    }
    return {
      type: "iteration",
      chunks: [...priorRunFinishedChunks, sourceChunk],
    };
  }
  const chunk =
    sourceChunk.type === EventType.RUN_ERROR
      ? normalizeRunErrorChunk(sourceChunk)
      : sourceChunk;
  const lifecycle = tanStackStreamEventLifecycle(chunk);
  if (isRunFinishedOutcome(lifecycle)) {
    runState.cancelled ||= lifecycle === "cancelled";
    if (chunk.type !== EventType.RUN_FINISHED) {
      panic("Unhandled TanStack completed stream event");
    }
    if (chunk.usage) {
      recordUsage(tokenUsageFromTerminalChunk(chunk));
    }
    // TanStack's agent loop can emit continuation events after a model
    // run finishes, notably `approval-requested` for a gated server tool.
    // The client already receives RUN_FINISHED only after the source is
    // drained; keep the server-side processor on that same ordering too.
    // Processing this now would finalize `responseMessage` before the
    // later approval event changes the tool call from `input-complete` to
    // `approval-requested`, persisting a turn that hydration then treats
    // as interrupted.
    deferredRunFinishedChunks.push(chunk);
    return { type: "deferred" };
  }
  // TanStack emits MESSAGES_SNAPSHOT before RUN_FINISHED at every
  // interrupt boundary (client tool, approval) so the client can rehydrate.
  // The persistence processor derives the assistant turn from the event
  // stream itself; feeding it the snapshot resets its stream state, and the
  // deferred RUN_FINISHED then finalizes with no active message, so
  // `onStreamEnd` never fires and a turn that carries a complete tool call
  // is persisted as an empty completion. Forward the snapshot; never
  // process it.
  if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
    processor.processChunk(chunk);
  }
  return { type: "chunk", chunk, lifecycle };
};

type FailedRunDetailsOptions = {
  chunk: PublicStreamChunk;
  sourceChunk: PublicStreamChunk;
};

const failedRunDetails = ({ chunk, sourceChunk }: FailedRunDetailsOptions) => {
  if (
    chunk.type !== EventType.RUN_ERROR ||
    sourceChunk.type !== EventType.RUN_ERROR
  ) {
    panic("Unhandled TanStack failed stream event");
  }
  return {
    chunk,
    usage: tokenUsageFromTerminalChunk(chunk),
    outcome: {
      type: "failed",
      error: classifyRunErrorChunk(sourceChunk),
    } as const satisfies ChatTurnOutcome,
  };
};

export const processServerChatStream = async function* ({
  abortSignal,
  runSignal = abortSignal,
  getRestorableCheckpoint,
  deadlineSignal,
  flushPendingSource,
  getResponseMessage,
  initialMessages,
  mapMessageId,
  onFinish,
  processor,
  source,
}: ProcessServerChatStreamProps): AsyncIterable<PublicStreamChunk> {
  const deferredRunFinishedChunks: PublicStreamChunk[] = [];
  const runState = { cancelled: false };
  // Whether the run streamed an answer (`chunkCarriesAnswer`): the one
  // measure of an empty run, read here from the chunks the persistence
  // processor is fed and in the attempt middleware from the chunks the model
  // sends. A continuation's message already holds the call the user
  // answered; the chunks hold only what this run added.
  let producedAnswer = false;
  const rawArgumentsByIncompleteToolCallId = new Map<string, string>();
  const toolCallsWithCompleteInput = new Set<string>();
  let usage: TokenUsage | undefined;
  const recordUsage = (recorded: TokenUsage | undefined) => {
    usage = recorded;
  };
  // One accepted turn has exactly one terminal callback. Set before awaiting
  // persistence so a callback failure cannot re-enter and double-write a
  // different outcome from catch/finally.
  const terminal: { state: "open" | "settled" } = { state: "open" };
  const {
    admissionLost,
    admissionCutByControl,
    cutShortOutcome,
    admissionLossOutcome,
    admissionFailureChunks,
    terminalize,
  } = createStreamSettlement({
    abortSignal,
    runSignal,
    deadlineSignal,
    flushPendingSource,
    getRestorableCheckpoint,
    getResponseMessage,
    mapMessageId,
    onFinish,
    processor,
    deferredRunFinishedChunks,
    rawArgumentsByIncompleteToolCallId,
    toolCallsWithCompleteInput,
    getUsage: () => usage,
    getProducedAnswer: () => producedAnswer,
    announceBeforeFailure: () => announceBeforeFailure(),
    terminal,
  });
  // Whether the client has been told which message this turn writes.
  let announcedAssistantMessage = false;
  // A run that fails before its first chunk still writes the turn's message
  // (see `createTerminalResponseMessage`). Name it before the error, or the
  // client opens a placeholder under an id of its own beside the message the
  // turn stored or continued.
  const announceBeforeFailure = (): StreamChunk[] =>
    announcedAssistantMessage
      ? []
      : [
          assistantMessageStartChunk(
            mapMessageId(ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL),
          ),
        ];
  try {
    const normalizedSource = ensureAssistantMessageStart({
      getOrCreateMessageId: () =>
        mapMessageId(ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL),
      source: remapOutgoingMessageIds({
        existingMessageIds: new Set(initialMessages.map(({ id }) => id)),
        mapMessageId,
        source,
      }),
    });

    for await (const sourceChunk of normalizedSource) {
      if (sourceChunk.type === EventType.TEXT_MESSAGE_START) {
        announcedAssistantMessage = true;
      }
      trackIncompleteToolCallInput(
        sourceChunk,
        rawArgumentsByIncompleteToolCallId,
      );
      producedAnswer ||= chunkCarriesAnswer(sourceChunk);
      if (sourceChunk.type === EventType.TOOL_CALL_END) {
        toolCallsWithCompleteInput.add(sourceChunk.toolCallId);
      }
      if (
        sourceChunk.type === EventType.RUN_ERROR &&
        (admissionLost() || admissionCutByControl())
      ) {
        usage = tokenUsageFromTerminalChunk(sourceChunk) ?? usage;
        const outcome = admissionCutByControl()
          ? cutShortOutcome()
          : admissionLossOutcome();
        await terminalize({ flushProcessor: admissionCutByControl(), outcome });
        for (const finish of deferredRunFinishedChunks.splice(0)) {
          yield finish;
        }
        yield* admissionFailureChunks(outcome);
        return;
      }
      const processed = processPersistenceChunk({
        sourceChunk,
        deferredRunFinishedChunks,
        processor,
        runState,
        recordUsage,
      });
      if (processed.type === "deferred") {
        continue;
      }
      if (processed.type === "iteration") {
        yield* processed.chunks;
        continue;
      }
      const { chunk, lifecycle } = processed;
      if (lifecycle === "failed") {
        const failure = failedRunDetails({ chunk, sourceChunk });
        usage = failure.usage ?? usage;
        await terminalize({
          flushProcessor: true,
          outcome: failure.outcome,
        });
        yield* announceBeforeFailure();
        yield failure.chunk;
        return;
      }
      yield chunk;
    }

    if (admissionLost() || admissionCutByControl()) {
      const outcome = admissionCutByControl()
        ? cutShortOutcome()
        : admissionLossOutcome();
      await terminalize({ flushProcessor: admissionCutByControl(), outcome });
      for (const chunk of deferredRunFinishedChunks.splice(0)) {
        yield chunk;
      }
      yield* admissionFailureChunks(outcome);
      return;
    }
    const finalRunFinishedChunks = deferredRunFinishedChunks.splice(0);
    for (const chunk of finalRunFinishedChunks) {
      processor.processChunk(chunk);
    }
    // The source is drained, so the turn is over. A finish that reports
    // `tool_calls` leaves the processor waiting for the next iteration of the
    // agent loop, and an iteration that never comes would leave the assistant
    // message unfinalized and `onStreamEnd` unfired: the turn a client tool or
    // an approval is waiting on would read as an empty completion. Finalizing
    // is what ends the message; it is the same call the SDK makes when it
    // drives the stream itself, and repeating it later is a no-op.
    processor.finalizeStream();
    const outcome = drainedRunOutcome({
      abortSignal: streamControlSignal(abortSignal, runSignal),
      deadlineSignal,
      finalRunFinishedChunks,
      responseMessage: getResponseMessage(),
      runCancelled: runState.cancelled,
      toolCallsWithCompleteInput,
    });
    await terminalize({
      // A cut-short outcome flushes the pending source into the processor,
      // which has to be finalized again for that content to reach the message.
      flushProcessor: CUT_SHORT_OUTCOME[outcome.type],
      outcome,
    });
    for (const chunk of finalRunFinishedChunks) {
      yield chunk;
    }
  } catch (error) {
    if (admissionLost()) {
      const outcome = admissionLossOutcome();
      await terminalize({ outcome });
      for (const finish of deferredRunFinishedChunks.splice(0)) {
        yield finish;
      }
      yield* admissionFailureChunks(outcome);
      return;
    }
    const kind = classifyAIError(error);
    if (abortSignal.aborted) {
      // An aborted stream is an expected exit (metered cutoff, ownership
      // loss); its rejection shape is not a stream defect even
      // when the classifier cannot name it.
      captureError(error, { kind });
      await terminalize({
        flushProcessor: true,
        outcome: cutShortOutcome(),
      });
    } else {
      reportStreamFailure(error, kind);
      await terminalize({
        flushProcessor: true,
        outcome: { type: "failed", error: kind },
      });
    }
    yield* announceBeforeFailure();
    yield {
      type: EventType.RUN_ERROR,
      message: kind,
      code: kind,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    };
  } finally {
    // Stop, budgets, ownership loss or transport failure can return the
    // generator before natural completion. Preserve its accumulated message.
    if (terminal.state === "open") {
      await terminalize({
        flushProcessor: true,
        outcome: admissionLost() ? admissionLossOutcome() : cutShortOutcome(),
      });
    }
  }
};

type ProcessTurnForPersistenceProps = Omit<
  ProcessServerChatStreamProps,
  "getResponseMessage" | "initialMessages" | "mapMessageId" | "processor"
> & {
  /** The history the run starts from: the messages it may continue. */
  initialMessages: ChatMessage[];
  owningAssistantMessageId: SafeId<"chatMessage"> | undefined;
  /** Filled while the stream runs; read once the response message ends. */
  restorationPairs: readonly ChatAnonRestoration[];
};

/**
 * The one place a turn's stream becomes the assistant message `onFinish`
 * persists: the turn's message ids, the stream processor that accumulates the
 * message, and the capture of its final state. Every turn that persists runs
 * through this function inside `streamChat`, which the chat harness drives
 * too, so a change to what gets persisted cannot pass a test that wires its
 * own copy.
 */
const processTurnForPersistence = ({
  visualOrigin,
  initialMessages,
  owningAssistantMessageId,
  restorationPairs,
  ...stream
}: ProcessTurnForPersistenceProps): AsyncIterable<PublicStreamChunk> => {
  const { processor, message } = createStreamMessageCapture({
    initialMessages,
    capture: (streamed) => {
      const convertedMessage = toChatMessage(streamed, visualOrigin);
      return convertedMessage === null
        ? null
        : attachRestorationMetadata({
            message: convertedMessage,
            restorationPairs,
          });
    },
  });
  return processServerChatStream({
    ...stream,
    getResponseMessage: message,
    initialMessages,
    mapMessageId: createTurnMessageIdMapper(owningAssistantMessageId),
    processor,
  });
};

type FinishResponseMessageProps = {
  mapMessageId: MessageIdMapper;
  outcome: ChatTurnOutcome;
  /** Whether the run streamed an answer (see `processServerChatStream`). */
  producedAnswer: boolean;
  responseMessage: ChatMessage | null;
  usage: TokenUsage | undefined;
};

const createTerminalResponseMessage = ({
  mapMessageId,
  outcome,
  producedAnswer,
  responseMessage,
  usage,
}: FinishResponseMessageProps): PersistableTerminalAssistantMessage => {
  if (outcome.type === "completed" && !producedAnswer) {
    throw new ChatEmptyCompletionError({
      message: CHAT_EMPTY_COMPLETION_MESSAGE,
    });
  }
  // A turn waits on the user only for a call its message holds
  // (`drainedRunOutcome` reads the interaction off that message), so a
  // waiting turn without a message is a defect here, not a provider outcome.
  if (
    outcome.type === "awaiting-user" &&
    (responseMessage === null || responseMessage.parts.length === 0)
  ) {
    panic("A turn awaiting the user holds no message to wait on");
  }

  // A turn that failed before its first part still spent what the provider
  // reported, so the usage rides on the message it writes either way.
  const persistableMessage = attachUsageMetadata({
    message:
      responseMessage === null
        ? toPersistableChatMessage({
            id: mapMessageId(ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL),
            parts: [],
            role: "assistant",
          })
        : normalizeFinalAssistantMessageId({
            mapMessageId,
            message: responseMessage,
          }),
    usage,
  });
  return attachTerminalTurnOutcome({
    message: persistableMessage,
    turnOutcome: outcome,
  });
};

const finalizeResponseProcessor = (processor: ChatStreamProcessor): void => {
  try {
    processor.finalizeStream();
  } catch (error) {
    captureError(error, { kind: "aborted_stream_finish_failed" });
  }
};

type TransformOutgoingStreamProps = {
  boundary: ChatThirdPartyBoundary;
  initialRestorationPlaceholders: ReadonlySet<string>;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantToolInputRefs?: AssistantToolInputRefResolver | undefined;
  resolveAssistantToolOutputRefs?: AssistantToolOutputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  registerPendingFlush?: (flushPending: () => StreamChunk[]) => void;
  restorationPairs: ChatAnonRestoration[];
  source: AsyncIterable<PublicStreamChunk>;
};

export const transformOutgoingStream = async function* ({
  boundary,
  initialRestorationPlaceholders,
  resolveAssistantTextRefs,
  resolveAssistantToolInputRefs,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  registerPendingFlush,
  restorationPairs,
  source,
}: TransformOutgoingStreamProps): AsyncIterable<StreamChunk> {
  const transform = createOutgoingChunkTransformer({
    boundary,
    initialRestorationPlaceholders,
    resolveAssistantTextRefs,
    resolveAssistantToolInputRefs,
    resolveAssistantToolOutputRefs,
    resolveAssistantValueRefs,
    restorationPairs,
  });
  registerPendingFlush?.(transform.flush);

  for await (const chunk of source) {
    for (const transformed of transform(chunk)) {
      yield transformed;
    }
  }

  for (const flushed of transform.flush()) {
    yield flushed;
  }
};

type TransformPersistenceVisibleStreamProps = Pick<
  TransformOutgoingStreamProps,
  "boundary" | "initialRestorationPlaceholders" | "restorationPairs" | "source"
>;

type PersistenceVisibleStream = AsyncIterable<StreamChunk> & {
  flushPending: () => StreamChunk[];
};

/** Deanonymize the processor's copy while preserving model-facing chat refs. */
export const transformPersistenceVisibleStream = ({
  boundary,
  initialRestorationPlaceholders,
  restorationPairs,
  source,
}: TransformPersistenceVisibleStreamProps): PersistenceVisibleStream => {
  let flushPending = (): StreamChunk[] => [];
  const transformed = transformOutgoingStream({
    boundary,
    initialRestorationPlaceholders,
    registerPendingFlush: (flush) => {
      flushPending = flush;
    },
    restorationPairs,
    source,
  });
  return {
    flushPending: () => flushPending(),
    [Symbol.asyncIterator]: () => transformed[Symbol.asyncIterator](),
  };
};

type TransformClientVisibleStreamProps = Pick<
  TransformOutgoingStreamProps,
  | "resolveAssistantTextRefs"
  | "resolveAssistantToolInputRefs"
  | "resolveAssistantToolOutputRefs"
  | "resolveAssistantValueRefs"
  | "source"
> & {
  /** Calls the history denied (see `findDeniedApprovals`). */
  deniedApprovals?: ReadonlyMap<string, DeniedApproval> | undefined;
  storedHistory: StoredHistory;
};

/**
 * Resolve refs only after the server-side processor has consumed its copy,
 * then present the calls the history denied as denied, built from the
 * resolved snapshot, and the rest of the history as stored.
 */
export const transformClientVisibleStream = ({
  deniedApprovals = new Map(),
  resolveAssistantTextRefs,
  resolveAssistantToolInputRefs,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  source,
  storedHistory,
}: TransformClientVisibleStreamProps): AsyncIterable<StreamChunk> =>
  presentStoredHistory({
    history: storedHistory,
    source: keepDeniedApprovalsOnScreen({
      deniedApprovals,
      source: transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        resolveAssistantTextRefs,
        resolveAssistantToolInputRefs,
        resolveAssistantToolOutputRefs,
        resolveAssistantValueRefs,
        restorationPairs: [],
        source,
      }),
    }),
  });

type OutgoingChunkTransformerOptions = {
  boundary: ChatThirdPartyBoundary;
  initialRestorationPlaceholders: ReadonlySet<string>;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantToolInputRefs?: AssistantToolInputRefResolver | undefined;
  resolveAssistantToolOutputRefs?: AssistantToolOutputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  restorationPairs: ChatAnonRestoration[];
};

const createOutgoingChunkTransformer = ({
  boundary,
  initialRestorationPlaceholders,
  resolveAssistantTextRefs,
  resolveAssistantToolInputRefs,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  restorationPairs,
}: OutgoingChunkTransformerOptions) => {
  const buffers = new Map<string, string>();
  const emittedPlaceholders = new Set(initialRestorationPlaceholders);
  const toolNamesByCallId = new Map<string, string>();
  const lenientCollector =
    boundary.type === "anonymized"
      ? buildLenientPlaceholderCollector(boundary)
      : null;

  if (boundary.type === "anonymized") {
    for (const placeholder of initialRestorationPlaceholders) {
      const original = boundary.redactionMap.get(placeholder);
      if (original !== undefined) {
        restorationPairs.push({ placeholder, original });
      }
    }
  }

  const emitRestorationDelta = (
    placeholders: ReadonlySet<string>,
  ): StreamChunk[] => {
    if (boundary.type !== "anonymized" || placeholders.size === 0) {
      return [];
    }

    const newPairs: ChatAnonRestoration[] = [];
    for (const placeholder of placeholders) {
      if (emittedPlaceholders.has(placeholder)) {
        continue;
      }
      const original = boundary.redactionMap.get(placeholder);
      if (original === undefined) {
        continue;
      }
      emittedPlaceholders.add(placeholder);
      const pair = { placeholder, original };
      restorationPairs.push(pair);
      newPairs.push(pair);
    }

    if (newPairs.length === 0) {
      return [];
    }

    return [
      {
        type: EventType.CUSTOM,
        name: STELLA_ANON_RESTORATIONS_EVENT,
        value: { pairs: newPairs },
        timestamp: Temporal.Now.instant().epochMilliseconds,
      },
    ];
  };

  const transformText = (text: string): string => {
    const resolved = resolveAssistantTextRefs
      ? resolveAssistantTextRefs(text)
      : text;
    if (boundary.type !== "anonymized") {
      return resolved;
    }
    return deanonymizeFromBoundary({ boundary, text: resolved });
  };

  const flushText = ({
    messageId,
    text,
  }: {
    messageId: string;
    text: string;
  }): StreamChunk[] => {
    if (text.length === 0) {
      return [];
    }

    return [
      ...emitRestorationDelta(collectTextPlaceholders(text)),
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: transformText(text),
        timestamp: Temporal.Now.instant().epochMilliseconds,
      },
    ];
  };

  const flushReasoning = ({
    messageId,
    text,
  }: {
    messageId: string;
    text: string;
  }): StreamChunk[] => {
    if (text.length === 0) {
      return [];
    }

    return [
      ...emitRestorationDelta(collectTextPlaceholders(text)),
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId,
        delta: transformText(text),
        timestamp: Temporal.Now.instant().epochMilliseconds,
      },
    ];
  };

  const flushToolArguments = ({
    text,
    toolCallId,
  }: {
    text: string;
    toolCallId: string;
  }): StreamChunk[] => {
    if (text.length === 0) {
      return [];
    }

    return [
      ...emitRestorationDelta(
        collectPlaceholdersFromText(text, lenientCollector),
      ),
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta:
          boundary.type === "anonymized"
            ? deanonymizeToolInputText(boundary, text)
            : text,
        timestamp: Temporal.Now.instant().epochMilliseconds,
      },
    ];
  };

  const transform = (chunk: PublicStreamChunk): StreamChunk[] => {
    if (chunk.type === EventType.TOOL_CALL_START) {
      const toolName = toolCallNameOf(chunk);
      if (toolName !== undefined) {
        toolNamesByCallId.set(chunk.toolCallId, toolName);
      }
      return [chunk];
    }

    if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
      return [
        ...emitRestorationDelta(
          collectUnknownStringPlaceholders(chunk.messages, lenientCollector),
        ),
        {
          ...chunk,
          messages: restoreSnapshotMessages(chunk.messages, {
            boundary,
            lenientCollector,
            resolveAssistantToolInputRefs,
            resolveAssistantToolOutputRefs,
            resolveAssistantValueRefs,
            toolNamesByCallId,
          }),
        },
      ];
    }

    if (
      chunk.type === EventType.RUN_FINISHED &&
      chunk.outcome?.type === "interrupt"
    ) {
      return [
        ...emitRestorationDelta(
          collectUnknownStringPlaceholders(
            chunk.outcome.interrupts,
            lenientCollector,
          ),
        ),
        {
          ...chunk,
          outcome: {
            ...chunk.outcome,
            interrupts: restoreInterrupts(chunk.outcome.interrupts, {
              boundary,
              resolveAssistantToolInputRefs,
              resolveAssistantValueRefs,
            }),
          },
        },
      ];
    }

    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      const key = `text:${chunk.messageId}`;
      const buffer = `${buffers.get(key) ?? ""}${chunk.delta}`;
      const prefixLength =
        boundary.type === "anonymized"
          ? getDeanonymisablePrefixLength(buffer)
          : getResolvedTextPrefixLength(buffer);
      buffers.set(key, buffer.slice(prefixLength));
      return flushText({
        messageId: chunk.messageId,
        text: buffer.slice(0, prefixLength),
      });
    }

    if (chunk.type === EventType.TEXT_MESSAGE_END) {
      const key = `text:${chunk.messageId}`;
      const pending = buffers.get(key) ?? "";
      buffers.delete(key);
      return [
        ...flushText({ messageId: chunk.messageId, text: pending }),
        chunk,
      ];
    }

    if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) {
      const key = `reasoning:${chunk.messageId}`;
      const buffer = `${buffers.get(key) ?? ""}${chunk.delta}`;
      const prefixLength =
        boundary.type === "anonymized"
          ? getDeanonymisablePrefixLength(buffer)
          : getResolvedTextPrefixLength(buffer);
      buffers.set(key, buffer.slice(prefixLength));
      return flushReasoning({
        messageId: chunk.messageId,
        text: buffer.slice(0, prefixLength),
      });
    }

    if (chunk.type === EventType.REASONING_MESSAGE_END) {
      const key = `reasoning:${chunk.messageId}`;
      const pending = buffers.get(key) ?? "";
      buffers.delete(key);
      return [
        ...flushReasoning({ messageId: chunk.messageId, text: pending }),
        chunk,
      ];
    }

    if (chunk.type === EventType.TOOL_CALL_ARGS) {
      const key = `tool:${chunk.toolCallId}`;
      const buffer = `${buffers.get(key) ?? ""}${chunk.delta}`;
      const prefixLength =
        boundary.type === "anonymized"
          ? getDeanonymisablePrefixLength(buffer)
          : buffer.length;
      buffers.set(key, buffer.slice(prefixLength));
      return flushToolArguments({
        text: buffer.slice(0, prefixLength),
        toolCallId: chunk.toolCallId,
      });
    }

    if (chunk.type === EventType.TOOL_CALL_END) {
      const key = `tool:${chunk.toolCallId}`;
      const pending = buffers.get(key) ?? "";
      buffers.delete(key);
      const toolName =
        toolCallNameOf(chunk) ?? toolNamesByCallId.get(chunk.toolCallId);
      if (toolName !== undefined) {
        toolNamesByCallId.set(chunk.toolCallId, toolName);
      }
      // The transformed values are written at the top level: the persistence
      // processor reads that before the metadata copy, and the wire encoder
      // merges a top-level value over the metadata copy when it re-normalizes
      // the chunk for the client.
      const rawInput = toolCallEndInputOf(chunk);
      let input: unknown;
      if (rawInput !== undefined) {
        input = transformToolCallInput({
          boundary,
          input: rawInput,
          resolveAssistantToolInputRefs,
          resolveAssistantValueRefs,
          toolName,
        });
      }
      const rawOutput = toolCallEndOutputOf(chunk);
      let output: unknown;
      if (rawOutput !== undefined) {
        output = transformToolCallOutput({
          boundary,
          output: rawOutput,
          resolveAssistantToolOutputRefs,
          resolveAssistantValueRefs,
          toolName,
        });
      }
      return [
        ...flushToolArguments({
          text: pending,
          toolCallId: chunk.toolCallId,
        }),
        input === undefined && output === undefined
          ? chunk
          : {
              ...chunk,
              ...(input === undefined ? {} : { input }),
              ...(output === undefined ? {} : { output }),
            },
      ];
    }

    if (chunk.type === EventType.TOOL_CALL_RESULT) {
      if (typeof chunk.content !== "string") {
        return panic("The engine emits a tool result's content as a string");
      }
      const toolName = toolNamesByCallId.get(chunk.toolCallId);
      const result = transformToolResultContent({
        boundary,
        content: chunk.content,
        lenientCollector,
        resolveAssistantToolOutputRefs,
        resolveAssistantValueRefs,
        toolName,
      });
      toolNamesByCallId.delete(chunk.toolCallId);
      return [
        ...emitRestorationDelta(result.placeholders),
        { ...chunk, content: result.content },
      ];
    }

    if (
      chunk.type === EventType.CUSTOM &&
      chunk.name === "tool-input-available"
    ) {
      const value = isRecord(chunk.value) ? chunk.value : {};
      const rawInput = value["input"];
      const toolName =
        typeof value["toolName"] === "string" ? value["toolName"] : undefined;
      const input = transformToolCallInput({
        boundary,
        input: rawInput,
        resolveAssistantToolInputRefs,
        resolveAssistantValueRefs,
        toolName,
      });
      return [
        ...emitRestorationDelta(
          collectUnknownStringPlaceholders(rawInput, lenientCollector),
        ),
        { ...chunk, value: { ...value, input } },
      ];
    }

    return [chunk];
  };

  transform.flush = (): StreamChunk[] => {
    const chunks: StreamChunk[] = [];
    for (const [key, value] of buffers) {
      if (key.startsWith("text:")) {
        chunks.push(
          ...flushText({
            messageId: key.slice("text:".length),
            text: value,
          }),
        );
      }
      if (key.startsWith("reasoning:")) {
        chunks.push(
          ...flushReasoning({
            messageId: key.slice("reasoning:".length),
            text: value,
          }),
        );
      }
      if (key.startsWith("tool:")) {
        chunks.push(
          ...flushToolArguments({
            toolCallId: key.slice("tool:".length),
            text: value,
          }),
        );
      }
    }
    buffers.clear();
    return chunks;
  };

  return transform;
};

const STELLA_REF_MARKER = "#stella-";

const getResolvedTextPrefixLength = (text: string): number => {
  const markerIndex = text.lastIndexOf(STELLA_REF_MARKER);
  if (markerIndex === -1) {
    return text.length;
  }

  const markerSuffix = text.slice(markerIndex);
  return /[\s)]/u.test(markerSuffix) ? text.length : markerIndex;
};

const PARTIAL_PLACEHOLDER_TAIL = /\[[A-Z][A-Z0-9_]*$|\[$/u;
const PLACEHOLDER_TOKEN = /\[[A-Z][A-Z0-9_]*\]/gu;
const PLACEHOLDER_INNER_TOKEN = /^[A-Z][A-Z0-9_]*$/u;
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/gu;

const getDeanonymisablePrefixLength = (text: string): number => {
  const match = PARTIAL_PLACEHOLDER_TAIL.exec(text);
  return match ? match.index : text.length;
};

export const collectInitialRestorationPlaceholders = ({
  latestMessageId,
  messages,
  redactionMap,
}: {
  latestMessageId: string;
  messages: ChatMessage[];
  redactionMap: ReadonlyMap<string, string>;
}): Set<string> => {
  const placeholders = new Set<string>();
  const latestMessage = messages.find(
    (message) => message.id === latestMessageId,
  );
  if (!latestMessage) {
    return placeholders;
  }

  for (const placeholder of collectUnknownStringPlaceholders(
    latestMessage.parts,
  )) {
    if (redactionMap.has(placeholder)) {
      placeholders.add(placeholder);
    }
  }
  return placeholders;
};

const collectTextPlaceholders = (text: string): Set<string> => {
  const placeholders = new Set<string>();
  PLACEHOLDER_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_TOKEN.exec(text)) !== null) {
    placeholders.add(match[0]);
  }
  return placeholders;
};

type LenientPlaceholderCollector = {
  pattern: RegExp;
  placeholderByToken: ReadonlyMap<string, string>;
};

const escapeRegex = (value: string): string =>
  value.replaceAll(REGEX_SPECIALS, "\\$&");

const buildLenientPlaceholderCollector = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
): LenientPlaceholderCollector | null => {
  const placeholderByToken = new Map<string, string>();
  const bracketed: string[] = [];
  const bracketless: string[] = [];

  for (const placeholder of boundary.redactionMap.keys()) {
    if (!placeholderByToken.has(placeholder)) {
      placeholderByToken.set(placeholder, placeholder);
      bracketed.push(escapeRegex(placeholder));
    }

    if (!placeholder.startsWith("[") || !placeholder.endsWith("]")) {
      continue;
    }

    const inner = placeholder.slice(1, -1);
    if (PLACEHOLDER_INNER_TOKEN.test(inner) && !placeholderByToken.has(inner)) {
      placeholderByToken.set(inner, placeholder);
      bracketless.push(escapeRegex(inner));
    }
  }

  if (bracketed.length === 0 && bracketless.length === 0) {
    return null;
  }

  bracketed.sort((a, b) => b.length - a.length);
  bracketless.sort((a, b) => b.length - a.length);

  const patterns: string[] = [];
  if (bracketed.length > 0) {
    patterns.push(bracketed.join("|"));
  }
  if (bracketless.length > 0) {
    patterns.push(`\\b(?:${bracketless.join("|")})\\b`);
  }

  return {
    pattern: new RegExp(patterns.join("|"), "gu"),
    placeholderByToken,
  };
};

const collectPlaceholdersFromText = (
  text: string,
  lenientCollector: LenientPlaceholderCollector | null,
): Set<string> => {
  if (lenientCollector === null) {
    return collectTextPlaceholders(text);
  }

  const placeholders = new Set<string>();
  lenientCollector.pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = lenientCollector.pattern.exec(text)) !== null) {
    const placeholder = lenientCollector.placeholderByToken.get(match[0]);
    if (placeholder !== undefined) {
      placeholders.add(placeholder);
    }
  }

  return placeholders;
};

const collectUnknownStringPlaceholders = (
  value: unknown,
  lenientCollector: LenientPlaceholderCollector | null = null,
): Set<string> => {
  const placeholders = new Set<string>();
  const walk = (next: unknown): void => {
    if (typeof next === "string") {
      for (const placeholder of collectPlaceholdersFromText(
        next,
        lenientCollector,
      )) {
        placeholders.add(placeholder);
      }
      return;
    }
    if (Array.isArray(next)) {
      for (const item of next) {
        walk(item);
      }
      return;
    }
    if (typeof next !== "object" || next === null) {
      return;
    }
    for (const nested of Object.values(next)) {
      walk(nested);
    }
  };
  walk(value);
  return placeholders;
};

type TransformToolCallInputOptions = {
  boundary: ChatThirdPartyBoundary;
  input: unknown;
  resolveAssistantToolInputRefs?: AssistantToolInputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  toolName: string | undefined;
};

/**
 * The client-bound copy of a tool call's input, deanonymized and with this
 * turn's chat refs resolved back to real ids.
 *
 * Ref resolution matters twice here. The approval card renders this input
 * verbatim, and a per-turn `mat_3` is meaningless to the person deciding
 * whether to allow the write; with the real id the client resolves the matter's
 * own name and colour. It also keeps the client's copy of the call equal to the
 * one `resolveAssistantMessageRefs` persists, which the approval continuation
 * compares field by field (`validateContinuationToolCallIntegrity`) before
 * replaying the call. `arguments` (the provider-visible copy) keeps its refs on
 * both sides and is not touched.
 */
const transformToolCallInput = ({
  boundary,
  input,
  resolveAssistantToolInputRefs,
  resolveAssistantValueRefs,
  toolName,
}: TransformToolCallInputOptions): unknown => {
  const visibleInput =
    boundary.type === "anonymized"
      ? deanonymizeUnknownStringsFromBoundary(boundary, input, "lenient")
      : input;
  const declaredInput =
    toolName !== undefined && resolveAssistantToolInputRefs !== undefined
      ? resolveAssistantToolInputRefs({ input: visibleInput, toolName })
      : visibleInput;
  return resolveAssistantValueRefs
    ? resolveAssistantValueRefs(declaredInput)
    : declaredInput;
};

type TransformToolCallOutputOptions = {
  boundary: ChatThirdPartyBoundary;
  output: unknown;
  resolveAssistantToolOutputRefs?: AssistantToolOutputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  toolName: string | undefined;
};

const transformToolCallOutput = ({
  boundary,
  output,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  toolName,
}: TransformToolCallOutputOptions): unknown => {
  const visibleOutput =
    boundary.type === "anonymized"
      ? deanonymizeUnknownStringsFromBoundary(boundary, output, "lenient")
      : output;
  const declaredOutput =
    toolName !== undefined && resolveAssistantToolOutputRefs !== undefined
      ? resolveAssistantToolOutputRefs({ output: visibleOutput, toolName })
      : visibleOutput;
  return resolveAssistantValueRefs
    ? resolveAssistantValueRefs(declaredOutput)
    : declaredOutput;
};

type RestoreVisibleStringOptions = {
  boundary: ChatThirdPartyBoundary;
  resolveAssistantToolInputRefs?: AssistantToolInputRefResolver | undefined;
  resolveAssistantToolOutputRefs?: AssistantToolOutputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
};

const createVisibleValueRestorer =
  ({ boundary, resolveAssistantValueRefs }: RestoreVisibleStringOptions) =>
  (value: unknown): unknown => {
    const visible =
      boundary.type === "anonymized"
        ? deanonymizeUnknownStringsFromBoundary(boundary, value, "lenient")
        : value;
    return resolveAssistantValueRefs?.(visible) ?? visible;
  };

const createVisibleStringRestorer = (options: RestoreVisibleStringOptions) => {
  const restoreValue = createVisibleValueRestorer(options);
  const restoreString = (text: string): string => {
    const resolved = restoreValue(text);
    if (typeof resolved !== "string") {
      return panic("Value restoration changed an AG-UI string's shape");
    }
    return resolved;
  };
  return restoreString;
};

const restoreRecordProperty = (
  record: Record<string, unknown>,
  key: string,
  restoreValue: (value: unknown) => unknown,
): void => {
  const value = record[key];
  if (value !== undefined) {
    record[key] = restoreValue(value);
  }
};

const restoreMetadataValuesInPlace = (
  metadata: unknown,
  restoreValue: (value: unknown) => unknown,
): void => {
  if (!isRecord(metadata)) {
    return;
  }
  const applicationMetadata = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== "tanstack:interruptBinding",
    ),
  );
  const restoredMetadata = restoreValue(applicationMetadata);
  if (!isRecord(restoredMetadata)) {
    panic("Value restoration changed AG-UI metadata's shape");
  }
  for (const [key, value] of Object.entries(restoredMetadata)) {
    metadata[key] = value;
  }

  const binding = metadata["tanstack:interruptBinding"];
  if (isRecord(binding)) {
    restoreRecordProperty(binding, "originalArgs", restoreValue);
  }
};

const restoreSnapshotToolArguments = ({
  argumentsText,
  options,
  restoreString,
  toolName,
}: {
  argumentsText: string;
  options: RestoreVisibleStringOptions;
  restoreString: (text: string) => string;
  toolName: string;
}): string => {
  const visibleArguments = restoreString(argumentsText);
  if (options.resolveAssistantToolInputRefs === undefined) {
    return visibleArguments;
  }

  const parsed = Result.try((): unknown => JSON.parse(visibleArguments));
  if (Result.isError(parsed)) {
    return visibleArguments;
  }
  const declared = options.resolveAssistantToolInputRefs({
    input: parsed.value,
    toolName,
  });
  const resolved = options.resolveAssistantValueRefs?.(declared) ?? declared;
  const serialized = Result.try(() => JSON.stringify(resolved));
  return Result.isOk(serialized) && typeof serialized.value === "string"
    ? serialized.value
    : visibleArguments;
};

/**
 * Restore only user/application-bearing fields in AG-UI messages. Protocol
 * identifiers and discriminators stay byte-for-byte stable, while arbitrary
 * application records (activity content and media metadata) restore every
 * nested leaf, even when an application happens to use keys such as `id` or
 * `type`.
 */
type RestoreSnapshotMessagesOptions = RestoreVisibleStringOptions & {
  lenientCollector: LenientPlaceholderCollector | null;
  toolNamesByCallId: Map<string, string>;
};

const restoreSnapshotMessages = <T extends object>(
  messages: T,
  options: RestoreSnapshotMessagesOptions,
): T => {
  const restored = structuredClone(messages);
  const restoreValue = createVisibleValueRestorer(options);
  const restoreString = createVisibleStringRestorer(options);
  if (!Array.isArray(restored)) {
    return restored;
  }
  for (const message of restored) {
    if (!isRecord(message)) {
      continue;
    }
    const role = message["role"];
    const content = message["content"];
    const toolCalls = message["toolCalls"];
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        if (!isRecord(toolCall) || !isRecord(toolCall["function"])) {
          continue;
        }
        const toolCallId = toolCall["id"];
        const toolName = toolCall["function"]["name"];
        if (typeof toolCallId === "string" && typeof toolName === "string") {
          options.toolNamesByCallId.set(toolCallId, toolName);
        }
      }
    }
    if (role === "activity") {
      message["content"] = restoreValue(content);
    } else if (role === "user" && Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) {
          continue;
        }
        if (part["type"] === "text") {
          restoreRecordProperty(part, "text", restoreValue);
        } else {
          restoreMetadataValuesInPlace(part["metadata"], restoreValue);
          if (part["type"] === "binary") {
            restoreRecordProperty(part, "filename", restoreValue);
          }
        }
      }
    } else if (
      role === "tool" &&
      typeof content === "string" &&
      typeof message["toolCallId"] === "string"
    ) {
      message["content"] = transformToolResultContent({
        boundary: options.boundary,
        content,
        lenientCollector: options.lenientCollector,
        resolveAssistantToolOutputRefs: options.resolveAssistantToolOutputRefs,
        resolveAssistantValueRefs: options.resolveAssistantValueRefs,
        toolName: options.toolNamesByCallId.get(message["toolCallId"]),
      }).content;
    } else if (typeof content === "string") {
      message["content"] = restoreString(content);
    }
    restoreMetadataValuesInPlace(message["metadata"], restoreValue);
    if (role === "tool") {
      restoreRecordProperty(message, "error", restoreValue);
    }

    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        if (!isRecord(toolCall) || !isRecord(toolCall["function"])) {
          continue;
        }
        const toolFunction = toolCall["function"];
        const argumentsText = toolFunction["arguments"];
        const toolName = toolFunction["name"];
        if (typeof argumentsText === "string" && typeof toolName === "string") {
          toolFunction["arguments"] = restoreSnapshotToolArguments({
            argumentsText,
            options,
            restoreString,
            toolName,
          });
        } else {
          restoreRecordProperty(toolFunction, "arguments", restoreValue);
        }
      }
    }
  }
  return restored;
};

/** Restore interrupt display/application payloads without touching correlation
 * ids, discriminators, expiry data, or response schemas. TanStack's binding is
 * protocol-owned except for `originalArgs`, which is application input. */
const restoreInterrupts = <T extends object>(
  interrupts: T,
  options: RestoreVisibleStringOptions,
): T => {
  const restored = structuredClone(interrupts);
  const restoreValue = createVisibleValueRestorer(options);
  if (!Array.isArray(restored)) {
    return restored;
  }
  for (const interrupt of restored) {
    if (!isRecord(interrupt)) {
      continue;
    }
    restoreRecordProperty(interrupt, "message", restoreValue);
    const metadata = interrupt["metadata"];
    restoreMetadataValuesInPlace(metadata, restoreValue);
    if (
      !isRecord(metadata) ||
      options.resolveAssistantToolInputRefs === undefined
    ) {
      continue;
    }

    const binding = metadata["tanstack:interruptBinding"];
    let toolName: string | undefined;
    if (typeof metadata["toolName"] === "string") {
      toolName = metadata["toolName"];
    } else if (isRecord(binding) && typeof binding["toolName"] === "string") {
      toolName = binding["toolName"];
    }
    if (toolName === undefined) {
      continue;
    }

    const resolveInput = (input: unknown): unknown => {
      const declared = options.resolveAssistantToolInputRefs?.({
        input,
        toolName,
      });
      return options.resolveAssistantValueRefs?.(declared) ?? declared;
    };
    if ("input" in metadata) {
      metadata["input"] = resolveInput(metadata["input"]);
    }
    if (isRecord(binding) && "originalArgs" in binding) {
      binding["originalArgs"] = resolveInput(binding["originalArgs"]);
    }
  }
  return restored;
};

type ParsedToolResultContent =
  | { type: "json"; value: unknown }
  | { type: "text"; value: string };

type TransformToolResultContentOptions = {
  boundary: ChatThirdPartyBoundary;
  content: string;
  lenientCollector: LenientPlaceholderCollector | null;
  resolveAssistantToolOutputRefs?: AssistantToolOutputRefResolver | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  toolName: string | undefined;
};

type TransformToolResultContentResult = {
  content: string;
  placeholders: ReadonlySet<string>;
};

const transformToolResultContent = ({
  boundary,
  content,
  lenientCollector,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  toolName,
}: TransformToolResultContentOptions): TransformToolResultContentResult => {
  const parsed = parseToolResultContent(content);
  const placeholders =
    boundary.type === "anonymized"
      ? collectToolResultPlaceholders({ lenientCollector, parsed })
      : new Set<string>();
  const visibleValue =
    boundary.type === "anonymized"
      ? deanonymizeUnknownStringsFromBoundary(boundary, parsed.value)
      : parsed.value;
  const declaredValue =
    toolName !== undefined && resolveAssistantToolOutputRefs !== undefined
      ? resolveAssistantToolOutputRefs({ output: visibleValue, toolName })
      : visibleValue;
  const resolvedValue = resolveAssistantValueRefs
    ? resolveAssistantValueRefs(declaredValue)
    : declaredValue;

  if (parsed.type === "json") {
    return {
      content: safeStringifyToolResultContent({
        fallback: content,
        value: resolvedValue,
      }),
      placeholders,
    };
  }

  return {
    content:
      typeof resolvedValue === "string"
        ? resolvedValue
        : safeStringifyToolResultContent({
            fallback: content,
            value: resolvedValue,
          }),
    placeholders,
  };
};

const parseToolResultContent = (content: string): ParsedToolResultContent => {
  try {
    const value: unknown = JSON.parse(content);
    return { type: "json", value };
  } catch {
    return { type: "text", value: content };
  }
};

const collectToolResultPlaceholders = ({
  lenientCollector,
  parsed,
}: {
  lenientCollector: LenientPlaceholderCollector | null;
  parsed: ParsedToolResultContent;
}): Set<string> =>
  parsed.type === "json"
    ? collectUnknownStringPlaceholders(parsed.value, lenientCollector)
    : collectPlaceholdersFromText(parsed.value, lenientCollector);

const safeStringifyToolResultContent = ({
  fallback,
  value,
}: {
  fallback: string;
  value: unknown;
}): string => {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : fallback;
  } catch {
    return fallback;
  }
};

const deanonymizeToolInputText = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  text: string,
): string => {
  const deanonymized = deanonymizeUnknownStringsFromBoundary(
    boundary,
    text,
    "lenient",
  );

  return typeof deanonymized === "string" ? deanonymized : text;
};

const attachRestorationMetadata = ({
  message,
  restorationPairs,
}: {
  message: ChatMessage;
  restorationPairs: readonly ChatAnonRestoration[];
}): ChatMessage => {
  if (restorationPairs.length === 0) {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...message.metadata,
      anonRestorations: { pairs: [...restorationPairs] },
    },
  };
};

const attachUsageMetadata = ({
  message,
  usage,
}: {
  message: PersistableChatMessage;
  usage: TokenUsage | undefined;
}): PersistableChatMessage => {
  if (usage === undefined) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      usage: chatMessageUsageFromTokenUsage(usage),
    },
  };
};

export const chatMessageUsageFromTokenUsage = (
  usage: TokenUsage,
): ChatMessageUsage => {
  const reasoningTokens = usage.completionTokensDetails?.reasoningTokens;
  return {
    completionTokens: usage.completionTokens,
    promptTokens: usage.promptTokens,
    totalTokens: usage.totalTokens,
    ...(reasoningTokens === undefined
      ? {}
      : { completionTokensDetails: { reasoningTokens } }),
  };
};

export const toChatMessage = (
  message: UIMessage,
  visualOrigin?: Pick<VisualResourceOrigin, "accepts">,
): ChatMessage | null => {
  const parts = toChatParts(message.parts, visualOrigin);
  if (parts.length === 0) {
    return null;
  }
  return {
    id: message.id,
    role: message.role,
    parts,
  };
};

// Which parts a message carries is decided by the model and SDK. The exhaustive
// persistence policy validates and canonicalizes every supported variant. When
// a future SDK variant is deliberately classified as dropped, the rest of the
// turn still persists; an entirely part-less turn remains null so no blank
// assistant message can reach storage.
const toChatParts = (
  parts: readonly UIMessage["parts"][number][],
  visualOrigin: Pick<VisualResourceOrigin, "accepts"> | undefined,
): ChatPart[] => {
  const chatParts: ChatPart[] = [];
  for (const part of parts) {
    const decision = classifyChatPartForPersistence(part, visualOrigin);
    if (decision.type === "persist") {
      chatParts.push(decision.part);
      continue;
    }
    // Telemetry only: the discriminator alone. A part's content can carry
    // document text, so it is never logged.
    logger.warn("Dropped an unsupported part from a streamed chat message", {
      "chat.part_type": decision.partType,
    });
  }
  const budgeted = applyChatPartPersistenceBudget(chatParts);
  for (const partType of budgeted.droppedPartTypes) {
    logger.warn("Dropped a rich part that exceeded the message budget", {
      "chat.part_type": partType,
    });
  }
  return budgeted.parts;
};

type HydrateMessagesProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  sendMode: ChatSendMode;
  userId: SafeId<"user">;
};

type XlsxCacheWrite = {
  file: StoredUserFile;
  text: string;
};

const persistXlsxCacheWrites = async ({
  cacheWrites,
  safeDb,
  userId,
}: {
  cacheWrites: readonly XlsxCacheWrite[];
  safeDb: SafeDb;
  userId: SafeId<"user">;
}) => {
  if (cacheWrites.length === 0) {
    return Result.ok(undefined);
  }

  const cacheTextByFileId = sql.join(
    cacheWrites.map(({ file, text }) => sql`WHEN ${file.id} THEN ${text}`),
    sql` `,
  );
  const fileOwnership = or(
    ...cacheWrites.map(({ file }) =>
      and(eq(userFiles.id, file.id), eq(userFiles.threadId, file.threadId)),
    ),
  );

  return await safeDb((tx) => {
    // audit: skip — derived text cache; no user-visible or source-file state changes
    const update = tx
      .update(userFiles)
      .set({
        extractedText: sql`CASE ${userFiles.id} ${cacheTextByFileId} END`,
      })
      .where(
        and(
          eq(userFiles.userId, userId),
          isNull(userFiles.extractedText),
          fileOwnership,
        ),
      );
    return update;
  });
};

export const hydrateMessages = async ({
  messages,
  safeDb,
  sendMode,
  userId,
}: HydrateMessagesProps) =>
  await Result.gen(async function* () {
    const userFilesById = yield* Result.await(
      readUserFilesByIds({
        messages,
        safeDb,
        userId,
      }),
    );
    const hydratedMessages: ChatMessage[] = [];
    const cacheWrites: XlsxCacheWrite[] = [];

    for (const message of messages) {
      const parts: ChatMessage["parts"] = [];

      for (const part of message.parts) {
        if (!isChatAttachmentPart(part)) {
          parts.push(part);
          continue;
        }

        const fileId = getUserFileIdFromAttachmentPart(part);
        if (fileId === null) {
          parts.push(part);
          continue;
        }

        const userFile = userFilesById.get(fileId);
        if (!userFile) {
          panic("Persisted chat file reference missing user_files row");
        }

        const hydratedPart = yield* Result.await(
          hydrateFilePart({
            extractedText: userFile.extractedText,
            fileName: userFile.fileName,
            mimeType: userFile.mimeType,
            sendMode,
            s3Key: userFile.s3Key,
          }),
        );

        if (hydratedPart.type === "blocked") {
          return Result.err(hydratedPart.error);
        }

        if (
          sendMode === CHAT_SEND_MODE.anonymized &&
          hydratedPart.type !== "anonymizable"
        ) {
          return Result.err(
            refuseAnonymizedCrossing({
              message: THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE,
              offerRawRetry: true,
              reason: "unsupported_content",
              site: "file_hydration",
              status: 422,
            }),
          );
        }

        if (hydratedPart.type === "anonymizable") {
          switch (hydratedPart.cache.status) {
            case "unchanged":
              break;
            case "write": {
              const { text } = hydratedPart.cache;
              cacheWrites.push({ file: userFile, text });
              userFilesById.set(fileId, {
                ...userFile,
                extractedText: text,
              });
              break;
            }
            default:
              hydratedPart.cache satisfies never;
              return panic("Unsupported XLSX cache status");
          }
        }

        parts.push(hydratedPart.part);
      }

      hydratedMessages.push({
        ...message,
        parts,
      });
    }

    yield* Result.await(
      persistXlsxCacheWrites({
        cacheWrites,
        safeDb,
        userId,
      }),
    );

    return Result.ok(hydratedMessages);
  });

type ReadUserFilesByIdsProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

const readUserFilesByIds = async ({
  messages,
  safeDb,
  userId,
}: ReadUserFilesByIdsProps): Promise<
  Result<Map<SafeId<"userFile">, StoredUserFile>, SafeDbError>
> => {
  const ids = collectMessageUserFileIds(messages);

  if (ids.length === 0) {
    return Result.ok(new Map<SafeId<"userFile">, StoredUserFile>());
  }

  const rowsResult = await safeDb((tx) =>
    tx.query.userFiles.findMany({
      where: {
        id: { in: ids },
        userId: { eq: userId },
      },
      columns: {
        id: true,
        userId: true,
        threadId: true,
        fileName: true,
        extractedText: true,
        mimeType: true,
        s3Key: true,
      },
      limit: ids.length,
    }),
  );

  return rowsResult.map((rows) => new Map(rows.map((row) => [row.id, row])));
};

const collectMessageUserFileIds = (
  messages: readonly ChatMessage[],
): SafeId<"userFile">[] => {
  const ids = new Set<SafeId<"userFile">>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isChatAttachmentPart(part)) {
        continue;
      }

      const fileId = getUserFileIdFromAttachmentPart(part);
      if (fileId !== null) {
        ids.add(fileId);
      }
    }
  }

  return [...ids];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
