import {
  EventType,
  maxIterations,
  StreamProcessor,
  toServerSentEventsResponse,
} from "@tanstack/ai";
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
import type { ModelRole, ReasoningEffort } from "@stll/ai-catalog";
import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
  createThirdPartyBoundaryRefusalPayload,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { userFiles } from "@/api/db/schema";
import type { UsageEventLane } from "@/api/db/schema";
import { modelAcceptsDocumentAttachment } from "@/api/handlers/chat/attachment-modality";
import {
  applyChatPartPersistenceBudget,
  attachTerminalTurnOutcome,
  classifyChatPartForPersistence,
  getChatAttachmentMimeType,
  getAwaitingUserInteraction,
  getUserFileIdFromAttachmentPart,
  isChatAttachmentPart,
  isChatDocumentPart,
  isChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatSafePrompt,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
import {
  CHAT_RUN_MODE,
  type ChatRunMode,
} from "@/api/handlers/chat/chat-schema";
import { compactModelMessagesForModel } from "@/api/handlers/chat/compaction";
import {
  createLoopRecoverySystemPrompt,
  detectModelLoop,
  getLoopRecoveryKey,
  shouldInjectLoopRecovery,
  shouldSurfaceFinalContentLoop,
  shouldStopLoopRecovery,
} from "@/api/handlers/chat/loop-detector";
import {
  createChatMessageIdMapper,
  ensureAssistantMessageStart,
  normalizeFinalAssistantMessageId,
  remapOutgoingMessageIds,
} from "@/api/handlers/chat/stream-message-identity";
import type { MessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
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
import type { StellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import type {
  ChatAnonRestoration,
  ChatMessage,
  ChatMessageUsage,
  ChatPart,
  ChatTurnOutcome,
  PersistableChatMessage,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import { hydrateFilePart } from "@/api/handlers/chat/upload-files";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { getTemperatureForRole, resolveCaching } from "@/api/lib/ai-config";
import {
  classifyAIError,
  isAnticipatedAIFailure,
  providerStatusFields,
} from "@/api/lib/ai-error";
import type { AIErrorKind } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
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
import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  streamChatChunks,
  toolCallEndInputOf,
  toolCallEndOutputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type { ChatTerminalError } from "@/api/lib/errors/tagged-errors";
import { errorFingerprint } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import {
  abortControllerFromSignal,
  mergeGenerationOptions,
  resolveTanStackTextModel,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";
import { tokenUsageFromRunFinishedChunk } from "@/api/lib/tanstack-ai-usage";

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

type StreamChatFinishEvent = {
  outcome: ChatTurnOutcome;
  responseMessage: PersistableTerminalAssistantMessage;
};

type StreamChatProps = {
  abortSignal: AbortSignal;
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
  onFinish: (event: StreamChatFinishEvent) => Promise<void> | void;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
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
  safeDb: SafeDb;
  systemSafe: ChatSafePrompt;
  systemUntrusted: ChatUntrustedPromptSuffix;
  /**
   * The org's accessible workspace ids, for the model-ingress guard: the
   * exact tenant set whose raw ids must never reach the provider (only chat
   * refs may). Already loaded on every send, so membership checks are free.
   */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  tools: ChatToolMap;
  externalMcpToolSource?: StellaMcpToolSource | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

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
}): Promise<
  Result<RunAgentResumeItem[] | undefined, HandlerError<422 | 500>>
> => {
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

export const streamChat = async ({
  abortSignal,
  devModelId,
  latestMessageId,
  runId,
  parentRunId,
  resume,
  messages: rawMessages,
  owningAssistantMessageId,
  onFinish,
  organizationId,
  orgAIConfig,
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
  safeDb,
  systemSafe,
  systemUntrusted,
  tenantWorkspaceIds,
  thirdPartyBoundary,
  threadId,
  tools,
  externalMcpToolSource,
  userId,
  workspaceId,
}: StreamChatProps): Promise<Response> => {
  const messages = pruneOrphanedToolParts(rawMessages);
  const agentBoundaryError = resolveAgentRunBoundaryError({
    boundary: thirdPartyBoundary,
    runMode,
  });
  if (agentBoundaryError !== null) {
    return thirdPartyBoundaryRefusalResponse(agentBoundaryError);
  }
  reserveThirdPartyBoundarySourcePlaceholders({
    boundary: thirdPartyBoundary,
    value: [systemSafe, systemUntrusted, messages, resume, tools],
  });
  const preparedUntrusted = await prepareTextForThirdParty({
    boundary: thirdPartyBoundary,
    text: systemUntrusted,
  });
  if (Result.isError(preparedUntrusted)) {
    return thirdPartyBoundaryRefusalResponse(preparedUntrusted.error);
  }
  const system =
    preparedUntrusted.value.length > 0
      ? `${systemSafe}${preparedUntrusted.value.startsWith("\n") ? "" : "\n\n"}${preparedUntrusted.value}`
      : systemSafe;
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
    return thirdPartyBoundaryRefusalResponse(rawPreparedMessages.error);
  }
  const preparedResumeResult = await prepareResumeForThirdParty({
    boundary: thirdPartyBoundary,
    resume,
  });
  if (Result.isError(preparedResumeResult)) {
    return thirdPartyBoundaryRefusalResponse(preparedResumeResult.error);
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

  const primaryModel = resolveTanStackTextModel({
    modelId: devModelId,
    organizationId,
    orgAIConfig,
    reasoningEffort,
    role: "chat",
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

  if (modelRejectsAnyDocument(primaryModel)) {
    // A plain 422, NOT a third-party-boundary refusal: that code is the sole
    // trigger for the "send without anonymization" retry, which cannot fix a
    // model that simply cannot read the attachment's format.
    return new Response(
      JSON.stringify({
        message:
          "This model cannot read one of the attached documents. Remove the attachment or switch to a model that supports it.",
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    );
  }

  const resolvedFallbackModel =
    devModelId === undefined
      ? resolveFallbackTextModel({
          organizationId,
          orgAIConfig,
          primaryModel,
          threadId,
        })
      : null;
  // Drop a fallback that would crash on a document the primary accepted; a
  // failover must not resurrect the modality mismatch.
  const fallbackModel =
    resolvedFallbackModel !== null &&
    modelRejectsAnyDocument(resolvedFallbackModel)
      ? null
      : resolvedFallbackModel;
  const abortController = abortControllerFromSignal(abortSignal);
  // Tool schemas are mostly server-built but may include org-configured
  // external MCP tool descriptions, so a hit here is telemetry, not a
  // turn-killing panic (the guard only panics for the system prompt).
  const modelTools = guardModelToolSchemas({
    tools: chatToolMapToArray(
      prepareToolsForThirdParty({ boundary: thirdPartyBoundary, tools }),
    ),
    workspaceIds: tenantWorkspaceIds,
  });
  const restorationPairs: ChatAnonRestoration[] = [];
  const mapAssistantMessageId = createChatMessageIdMapper();
  let responseMessage: ChatMessage | null = null;
  const processor = new StreamProcessor({
    initialMessages: preparedMessageList,
    events: {
      onStreamEnd: (message) => {
        const convertedMessage = toChatMessage(message);
        responseMessage =
          convertedMessage === null
            ? null
            : attachRestorationMetadata({
                message: convertedMessage,
                restorationPairs,
              });
      },
    },
  });

  const stream = runChatAttempts({
    abortController,
    abortSignal,
    devModelId,
    externalMcpToolSource,
    fallbackModel,
    organizationId,
    orgAIConfig,
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
      messages: preparedMessageList,
      system: guardedSystem,
      tenantWorkspaceIds,
      tools: modelTools,
    },
    thirdPartyBoundary,
    threadId,
    userId,
    workspaceId,
  });

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
    source: stream,
  });
  const processedStream = processServerChatStream({
    abortSignal,
    existingMessageIds: new Set(preparedMessageList.map(({ id }) => id)),
    flushPendingSource: persistenceVisibleStream.flushPending,
    preservedTerminalMessageId: owningAssistantMessageId,
    onFinish,
    processor,
    source: persistenceVisibleStream,
    mapMessageId: mapAssistantMessageId,
    getResponseMessage: () => responseMessage,
  });
  const output = transformClientVisibleStream({
    resolveAssistantTextRefs,
    resolveAssistantToolInputRefs,
    resolveAssistantToolOutputRefs,
    resolveAssistantValueRefs,
    source: processedStream,
  });

  return toServerSentEventsResponse(output, { abortController });
};

const thirdPartyBoundaryRefusalResponse = (
  error: HandlerError<422 | 500>,
): Response =>
  new Response(
    JSON.stringify(createThirdPartyBoundaryRefusalPayload(error.message)),
    {
      headers: { "Content-Type": "application/json" },
      status: error.status,
    },
  );

type ResolveAgentRunBoundaryErrorInput = {
  boundary: Pick<ChatThirdPartyBoundary, "type">;
  runMode: ChatRunMode | undefined;
};

export const resolveAgentRunBoundaryError = ({
  boundary,
  runMode,
}: ResolveAgentRunBoundaryErrorInput): HandlerError<422> | null => {
  if (
    runMode !== CHAT_RUN_MODE.agent ||
    boundary.type !== CHAT_SEND_MODE.anonymized
  ) {
    return null;
  }

  return new HandlerError({
    code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
    status: 422,
    message:
      "Agent sandbox access is not available in anonymized mode because its MCP tools can return raw workspace data.",
  });
};

type ChatAttemptState = {
  emptyCompletion: ChatEmptyCompletionError | null;
  finalLoopDetection: ChatLoopDetectedError | null;
};

export const createChatAttemptState = (): ChatAttemptState => ({
  emptyCompletion: null,
  finalLoopDetection: null,
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
  usage: TokenUsage | undefined;
};

export const recordChatAttemptFinish = ({
  captureError: captureAttemptError = captureError,
  finishReason,
  messages,
  modelInfo,
  state,
  threadId,
  usage,
}: RecordChatAttemptFinishProps): void => {
  const loopDetection = detectModelLoop(messages);
  if (shouldSurfaceFinalContentLoop(loopDetection)) {
    state.finalLoopDetection = new ChatLoopDetectedError({
      message: CHAT_LOOP_DETECTED_MESSAGE,
    });
  }

  if (finishReason !== "stop" || usage?.completionTokens !== 0) {
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
export const guardedMcpClients = ({
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
  orgAIConfig: OrgAIConfig | null;
  primaryModel: ResolvedTanStackTextModel;
  threadId: SafeId<"chatThread">;
};

const resolveFallbackTextModel = ({
  organizationId,
  orgAIConfig,
  primaryModel,
  threadId,
}: ResolveFallbackTextModelProps): ResolvedTanStackTextModel | null => {
  try {
    const fallbackModel = resolveTanStackTextModel({
      organizationId,
      orgAIConfig,
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
  safeDb,
  selectedModelId,
  usageLane,
  threadId,
  userId,
  workspaceId,
}: CreateChatAttemptAnalyticsProps): TanStackAIAnalyticsCallbacks =>
  createTanStackAIAnalyticsCallbacks({
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
  messages: GuardedModelMessages<ChatMessage[]>;
  system: GuardedSystemPrompt;
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
  abortController: AbortController;
  abortSignal: AbortSignal;
  devModelId: string | undefined;
  externalMcpToolSource: StellaMcpToolSource | undefined;
  fallbackModel: ResolvedTanStackTextModel | null;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
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
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const runChatAttempts = async function* ({
  abortController,
  abortSignal,
  devModelId,
  externalMcpToolSource,
  fallbackModel,
  organizationId,
  orgAIConfig,
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
  userId,
  workspaceId,
}: RunChatAttemptsProps): AsyncIterable<PublicStreamChunk> {
  const primaryState = createChatAttemptState();
  // The caller resolves an explicit agent sandbox before persisting the
  // incoming message. A normal chat never carries a plan, even when the engine
  // is enabled, so BYOK/model-selected turns keep the chosen adapter.
  yield* runChatAttempt({
    abortController,
    abortSignal,
    compactionFeature: "chat.step_compaction",
    externalMcpToolSource,
    feature: "chat.stream",
    model: primaryModel,
    modelId: devModelId,
    organizationId,
    orgAIConfig,
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
  yield* runChatAttempt({
    abortController,
    abortSignal,
    compactionFeature: "chat.step_compaction_fallback",
    externalMcpToolSource,
    feature: "chat.stream_fallback",
    model: fallbackModel,
    modelId: undefined,
    organizationId,
    orgAIConfig,
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
  orgAIConfig: OrgAIConfig | null;
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
  orgAIConfig,
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
  userId,
  workspaceId,
}: RunChatAttemptProps): AsyncIterable<PublicStreamChunk> {
  // The one place the guard's brands are widened back to the plain types the
  // provider SDK takes: everything below this line is dispatch.
  const {
    messages: preparedMessages,
    system: baseSystem,
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
      adapter,
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
          compactionAnalytics,
          compactionFeature,
          model,
          modelId,
          organizationId,
          orgAIConfig,
          role,
          state,
          tenantWorkspaceIds,
          threadId,
        }),
        sandboxMiddleware,
      ],
    });
    return;
  }

  const stream = streamChatChunks({
    adapter: model.adapter,
    messages: preparedMessages,
    tools: projectChatToolSchemasForProvider({
      modelTools,
      provider: model.provider,
    }),
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
    ...systemPromptsPatch({ caching, model, system: baseSystem }),
    modelOptions: mergeGenerationOptions({
      caching,
      model,
      maxOutputTokens: undefined,
      serviceTier: "standard",
      temperature: getTemperatureForRole(role),
    }),
    middleware: [
      analytics.middleware,
      createChatRuntimeMiddleware({
        abortSignal,
        baseSystem,
        compactionAnalytics,
        compactionFeature,
        model,
        modelId,
        organizationId,
        orgAIConfig,
        role,
        state,
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
  compactionAnalytics: TanStackAIAnalyticsCallbacks;
  compactionFeature: string;
  model: ResolvedTanStackTextModel;
  modelId: string | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  role: ChatAttemptRole;
  state: ChatAttemptState;
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  threadId: SafeId<"chatThread">;
};

const createChatRuntimeMiddleware = ({
  abortSignal,
  baseSystem,
  compactionAnalytics,
  compactionFeature,
  model,
  modelId,
  organizationId,
  orgAIConfig,
  role,
  state,
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
          usage: event.info.usage,
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
          patch.systemPrompts = guardedLoopRecoveryPrompts({
            baseSystem,
            detection: loopDetection,
            tenantWorkspaceIds,
          });
        }
      }

      const compactedMessages = await compactModelMessagesForModel({
        abortSignal,
        aiAnalytics: compactionAnalytics,
        messages: config.messages,
        modelId,
        organizationId,
        orgAIConfig,
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

      return Object.keys(patch).length === 0 ? undefined : patch;
    },
  };
};

type ProcessServerChatStreamProps = {
  abortSignal: AbortSignal;
  existingMessageIds?: ReadonlySet<string> | undefined;
  flushPendingSource?: (() => PublicStreamChunk[]) | undefined;
  getResponseMessage: () => ChatMessage | null;
  mapMessageId: MessageIdMapper;
  onFinish: (event: StreamChatFinishEvent) => Promise<void> | void;
  preservedTerminalMessageId?: SafeId<"chatMessage"> | undefined;
  processor: StreamProcessor;
  source: AsyncIterable<PublicStreamChunk>;
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

// An adapter forwards the provider's structured error body as `rawEvent` only
// when the SDK exception exposes one. An exception that carries the status as a
// plain field and stringifies the response body into its message arrives with
// neither `rawEvent` nor `code`, so the error rebuilt from the chunk holds no
// status at all, and every failure from that provider (quota, billing, retired
// model and outage alike) falls to `unknown`. Recover the body from the
// message when the message is one. It is read for classification only and
// never logged: a provider message can echo request content.
const isErrorBodyRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const providerErrorBody = (
  message: string,
): Record<string, unknown> | undefined => {
  // `JSON.parse` skips leading whitespace, so the guard must too; otherwise a
  // body an adapter passed through verbatim would be dropped over a newline.
  if (!message.trimStart().startsWith("{")) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(message));
  if (Result.isError(parsed)) {
    return undefined;
  }
  return isErrorBodyRecord(parsed.value) ? parsed.value : undefined;
};

const providerDetailFromRunErrorChunk = (chunk: RunErrorChunk): unknown => {
  const rawEvent: unknown = chunk.rawEvent;
  return rawEvent ?? providerErrorBody(runErrorMessage(chunk));
};

const errorForRunErrorChunk = (chunk: RunErrorChunk): unknown =>
  providerDetailFromRunErrorChunk(chunk) ?? errorFromRunErrorChunk(chunk);

const classifyRunErrorChunk = (chunk: RunErrorChunk): AIErrorKind => {
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
// unanticipated shape is logged at ERROR severity.
// Fingerprint only — provider error messages can echo request content.
const reportStreamFailure = (error: unknown, kind: AIErrorKind): void => {
  captureError(error, { kind });
  if (!isAnticipatedAIFailure(error, kind)) {
    logger.error("chat.stream_failed", {
      kind,
      ...errorFingerprint(error),
      ...providerStatusFields(error),
    });
  }
};

const normalizeRunErrorChunk = (chunk: RunErrorChunk): RunErrorChunk => {
  const error = errorForRunErrorChunk(chunk);
  const kind = classifyRunErrorChunk(chunk);
  reportStreamFailure(error, kind);
  return {
    ...chunk,
    message: kind,
    code: kind,
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

export const processServerChatStream = async function* ({
  abortSignal,
  existingMessageIds = new Set(),
  flushPendingSource,
  getResponseMessage,
  mapMessageId,
  onFinish,
  preservedTerminalMessageId,
  processor,
  source,
}: ProcessServerChatStreamProps): AsyncIterable<PublicStreamChunk> {
  const deferredRunFinishedChunks: PublicStreamChunk[] = [];
  const rawArgumentsByIncompleteToolCallId = new Map<string, string>();
  const toolCallsWithCompleteInput = new Set<string>();
  let usage: TokenUsage | undefined;
  // One accepted turn has exactly one terminal callback. Set before awaiting
  // persistence so a callback failure cannot re-enter and double-write a
  // different outcome from catch/finally.
  const terminal: { state: "open" | "settled" } = { state: "open" };
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
    if (outcome.type === "interrupted" && flushPendingSource !== undefined) {
      for (const chunk of flushPendingSource()) {
        trackIncompleteToolCallInput(chunk, rawArgumentsByIncompleteToolCallId);
        processor.processChunk(chunk);
      }
    }
    if (flushProcessor) {
      finalizeResponseProcessor(processor);
    }
    // An empty completion is a provider outcome: the model produced no
    // persistable part. A run that carried a complete tool call cannot be
    // one; losing that call between the stream and the persistence
    // processor is a defect in this pipeline, so it must not be graded as
    // an anticipated provider state.
    if (
      (outcome.type === "completed" || outcome.type === "awaiting-user") &&
      toolCallsWithCompleteInput.size > 0 &&
      (getResponseMessage()?.parts.length ?? 0) === 0
    ) {
      panic(
        "Persistence processor dropped an assistant turn that carried a complete tool call",
      );
    }
    const responseMessage =
      outcome.type === "interrupted"
        ? restoreInterruptedToolCallInputs(
            getResponseMessage(),
            rawArgumentsByIncompleteToolCallId,
          )
        : getResponseMessage();
    const terminalResponseMessage = createTerminalResponseMessage({
      mapMessageId,
      outcome,
      preservedTerminalMessageId,
      responseMessage,
      usage,
    });
    terminal.state = "settled";
    await onFinish({ outcome, responseMessage: terminalResponseMessage });
  };
  try {
    const normalizedSource = ensureAssistantMessageStart({
      getOrCreateMessageId: () =>
        mapMessageId(ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL),
      source: remapOutgoingMessageIds({
        existingMessageIds,
        mapMessageId,
        source,
      }),
    });

    for await (const sourceChunk of normalizedSource) {
      trackIncompleteToolCallInput(
        sourceChunk,
        rawArgumentsByIncompleteToolCallId,
      );
      if (sourceChunk.type === EventType.TOOL_CALL_END) {
        toolCallsWithCompleteInput.add(sourceChunk.toolCallId);
      }
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
        for (const chunk of priorRunFinishedChunks) {
          yield chunk;
        }
        yield sourceChunk;
        continue;
      }
      const chunk =
        sourceChunk.type === EventType.RUN_ERROR
          ? normalizeRunErrorChunk(sourceChunk)
          : sourceChunk;
      const lifecycle = tanStackStreamEventLifecycle(chunk);
      if (lifecycle === "completed" || lifecycle === "waiting") {
        if (chunk.type !== EventType.RUN_FINISHED) {
          panic("Unhandled TanStack completed stream event");
        }
        if (chunk.usage) {
          usage = tokenUsageFromRunFinishedChunk(chunk);
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
        continue;
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
      if (lifecycle === "failed") {
        if (chunk.type !== EventType.RUN_ERROR) {
          panic("Unhandled TanStack failed stream event");
        }
        await terminalize({
          flushProcessor: true,
          outcome: { type: "failed", error: classifyRunErrorChunk(chunk) },
        });
        yield chunk;
        return;
      }
      yield chunk;
    }

    const finalRunFinishedChunks = deferredRunFinishedChunks.splice(0);
    for (const chunk of finalRunFinishedChunks) {
      processor.processChunk(chunk);
    }
    const awaitingUserInteraction =
      getAwaitingUserInteraction(getResponseMessage());
    // A client-resolved call whose input never finished (no TOOL_CALL_END)
    // cannot be answered by any client, so the turn fails instead of waiting.
    const incompleteClientInteraction =
      awaitingUserInteraction !== null &&
      awaitsCompleteInput(awaitingUserInteraction) &&
      !toolCallsWithCompleteInput.has(awaitingUserInteraction.toolCallId);
    let outcome: ChatTurnOutcome;
    if (incompleteClientInteraction) {
      outcome = { type: "failed", error: "unknown" };
    } else if (awaitingUserInteraction === null) {
      outcome = { type: "completed" };
    } else {
      outcome = {
        type: "awaiting-user",
        interaction: awaitingUserInteraction,
      };
    }
    await terminalize({
      outcome,
    });
    for (const chunk of finalRunFinishedChunks) {
      yield chunk;
    }
  } catch (error) {
    const kind = classifyAIError(error);
    if (abortSignal.aborted) {
      // An aborted stream is an expected exit (metered cutoff, client
      // disconnect); its rejection shape is not a stream defect even
      // when the classifier cannot name it.
      captureError(error, { kind });
      await terminalize({
        flushProcessor: true,
        outcome: { type: "interrupted", reason: "timeout" },
      });
    } else {
      reportStreamFailure(error, kind);
      await terminalize({
        flushProcessor: true,
        outcome: { type: "failed", error: kind },
      });
    }
    yield {
      type: EventType.RUN_ERROR,
      message: kind,
      code: kind,
      timestamp: Date.now(),
    };
  } finally {
    // Client-disconnect teardown: Bun's `ReadableStream.cancel()` fires when the
    // socket drops, tanstack breaks its `for await` on the aborted controller,
    // and that `.return()`s this generator mid-stream, so neither the
    // natural-completion finish nor the `catch` ran. The metered provider call
    // is decoupled from the socket, so the model kept producing and was metered;
    // persist whatever content accumulated so a completed-or-partial answer is
    // not silently lost on remount. Skipped when the stream already finished or
    // failed, and a no-op when nothing accumulated (finalizeStream drops
    // whitespace-only messages). Awaiting here completes even on teardown, and
    // persistence uses the shared RLS pool, not a request-scoped handle.
    if (terminal.state === "open") {
      await terminalize({
        flushProcessor: true,
        outcome: { type: "interrupted", reason: "client-disconnected" },
      });
    }
  }
};

type FinishResponseMessageProps = {
  mapMessageId: MessageIdMapper;
  outcome: ChatTurnOutcome;
  preservedTerminalMessageId: SafeId<"chatMessage"> | undefined;
  responseMessage: ChatMessage | null;
  usage: TokenUsage | undefined;
};

const createTerminalResponseMessage = ({
  mapMessageId,
  outcome,
  preservedTerminalMessageId,
  responseMessage,
  usage,
}: FinishResponseMessageProps): PersistableTerminalAssistantMessage => {
  if (
    (outcome.type === "completed" || outcome.type === "awaiting-user") &&
    (!responseMessage || responseMessage.parts.length === 0)
  ) {
    throw new ChatEmptyCompletionError({
      message: CHAT_EMPTY_COMPLETION_MESSAGE,
    });
  }

  const persistableMessage =
    responseMessage === null
      ? toPersistableChatMessage({
          id: mapMessageId(ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL),
          parts: [],
          role: "assistant",
        })
      : attachUsageMetadata({
          message: normalizeFinalAssistantMessageId({
            mapMessageId,
            message: responseMessage,
            preservedMessageId: preservedTerminalMessageId,
          }),
          usage,
        });
  return attachTerminalTurnOutcome({
    message: persistableMessage,
    turnOutcome: outcome,
  });
};

const finalizeResponseProcessor = (processor: StreamProcessor): void => {
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
>;

/** Resolve refs only after the server-side processor has consumed its copy. */
export const transformClientVisibleStream = ({
  resolveAssistantTextRefs,
  resolveAssistantToolInputRefs,
  resolveAssistantToolOutputRefs,
  resolveAssistantValueRefs,
  source,
}: TransformClientVisibleStreamProps): AsyncIterable<StreamChunk> =>
  transformOutgoingStream({
    boundary: { type: "raw" },
    initialRestorationPlaceholders: new Set(),
    resolveAssistantTextRefs,
    resolveAssistantToolInputRefs,
    resolveAssistantToolOutputRefs,
    resolveAssistantValueRefs,
    restorationPairs: [],
    source,
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
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

export const toChatMessage = (message: UIMessage): ChatMessage | null => {
  const parts = toChatParts(message.parts);
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
): ChatPart[] => {
  const chatParts: ChatPart[] = [];
  for (const part of parts) {
    const decision = classifyChatPartForPersistence(part);
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

        const file = userFilesById.get(fileId);
        if (!file) {
          panic("Persisted chat file reference missing user_files row");
        }

        const hydratedPart = yield* Result.await(
          hydrateFilePart({
            extractedText: file.extractedText,
            // eslint-disable-next-line security-guards/no-raw-filename-write -- DB read-back from user_files, already sanitized on upload
            fileName: file.fileName,
            mimeType: file.mimeType,
            sendMode,
            s3Key: file.s3Key,
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
            new HandlerError({
              code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
              status: 422,
              message: THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE,
            }),
          );
        }

        if (hydratedPart.type === "anonymizable") {
          switch (hydratedPart.cache.status) {
            case "unchanged":
              break;
            case "write": {
              const { text } = hydratedPart.cache;
              cacheWrites.push({ file, text });
              userFilesById.set(fileId, {
                ...file,
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
