import {
  chat,
  EventType,
  maxIterations,
  StreamProcessor,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import type {
  ChatMiddleware,
  ChatMiddlewareConfig,
  ModelMessage,
  ServerTool,
  StreamChunk,
  TokenUsage,
  UIMessage,
} from "@tanstack/ai";
import { panic, Result } from "better-result";

import type { ModelRole } from "@stll/ai-catalog";
import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
  createThirdPartyBoundaryRefusalPayload,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
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
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatSafePrompt,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
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
  createTanStackTerminalHooks,
  tanStackStreamEventLifecycle,
} from "@/api/handlers/chat/tanstack-chat-lifecycle";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  deanonymizeFromBoundary,
  deanonymizeUnknownStringsFromBoundary,
  prepareMessagesForThirdParty,
  prepareMcpToolSourceForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
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
import { classifyAIError } from "@/api/lib/ai-error";
import type { AIErrorKind } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  chatToolMapToArray,
  type ChatTool,
  type ChatToolMap,
} from "@/api/lib/chat/chat-tool-types";
import {
  guardModelMessages,
  guardModelSystemPrompt,
  guardModelToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";
import type {
  GuardedModelMessages,
  GuardedSystemPrompt,
  GuardedToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";
import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
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

const MAX_TOOL_STEPS = 100;
const THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE =
  "Cannot send this attachment to the AI in anonymized mode because stella cannot extract and anonymize it safely.";
const STELLA_ANON_RESTORATIONS_EVENT = "stella.anon-restorations";
const ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL = "stella-assistant-response";
const CHAT_LOOP_DETECTED_MESSAGE =
  "The AI model repeated the same work and could not recover. Please try again with a narrower request.";
const CHAT_EMPTY_COMPLETION_MESSAGE =
  "Model returned finish_reason=stop with zero output";

type StoredUserFile = {
  fileName: string;
  id: SafeId<"userFile">;
  mimeType: string;
  s3Key: string;
  threadId: SafeId<"chatThread">;
  userId: string;
};

type AssistantValueRefResolver = ChatRefRegistry["resolveAssistantValueRefs"];

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
  latestMessageId: string;
  messages: ChatMessage[];
  onFinish: (event: StreamChatFinishEvent) => Promise<void> | void;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
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

export const streamChat = async ({
  abortSignal,
  devModelId,
  latestMessageId,
  messages: rawMessages,
  onFinish,
  organizationId,
  orgAIConfig,
  promptCacheKey,
  promptCachingEnabled,
  resolveAssistantTextRefs,
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
  // Messages carry user-authored and historical text (mention hrefs from
  // before ref hydration covered user text, pasted workspace URLs), so hits
  // are redacted rather than refused: old threads keep working, telemetry
  // records the path of every residual ingress leak, and the model loses
  // only an id it could not legitimately use.
  const preparedMessageList = guardModelMessages({
    messages: rawPreparedMessages.value,
    workspaceIds: tenantWorkspaceIds,
  });

  const primaryModel = resolveTanStackTextModel({
    modelId: devModelId,
    organizationId,
    orgAIConfig,
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
    safeDb,
    surfaces: {
      messages: preparedMessageList,
      system: guardedSystem,
      tools: modelTools,
    },
    thirdPartyBoundary,
    threadId,
    userId,
    workspaceId,
  });

  const output = processServerChatStream({
    abortSignal,
    onFinish,
    processor,
    source: transformOutgoingStream({
      boundary: thirdPartyBoundary,
      initialRestorationPlaceholders:
        thirdPartyBoundary.type === "anonymized"
          ? collectInitialRestorationPlaceholders({
              latestMessageId,
              messages: preparedMessageList,
              redactionMap: thirdPartyBoundary.redactionMap,
            })
          : new Set<string>(),
      resolveAssistantTextRefs,
      resolveAssistantValueRefs,
      restorationPairs,
      source: stream,
    }),
    mapMessageId: mapAssistantMessageId,
    getResponseMessage: () => responseMessage,
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
): ChatLoopDetectedError | ChatEmptyCompletionError | null =>
  state.finalLoopDetection ?? state.emptyCompletion;

const projectServerToolsForProvider = ({
  provider,
  serverTools,
}: {
  provider: string;
  serverTools: readonly ServerTool[];
}): ServerTool[] => {
  const projectionOptions = providerSafeJsonSchemaOptionsForTanStackProvider(
    provider,
    "tool",
  );
  const projectedTools: ServerTool[] = [];
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
  threadId,
  userId,
  workspaceId,
}: CreateChatAttemptAnalyticsProps): TanStackAIAnalyticsCallbacks =>
  createTanStackAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
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
  safeDb,
  surfaces,
  thirdPartyBoundary,
  threadId,
  userId,
  workspaceId,
}: RunChatAttemptsProps): AsyncIterable<StreamChunk> {
  const primaryState = createChatAttemptState();
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
    role: "chat",
    safeDb,
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
    !(primaryError instanceof ChatEmptyCompletionError) ||
    fallbackModel === null
  ) {
    throw primaryError;
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
  externalMcpToolSource: StellaMcpToolSource | undefined;
  feature: string;
  model: ResolvedTanStackTextModel;
  modelId: string | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  role: ChatAttemptRole;
  safeDb: SafeDb;
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
  role,
  safeDb,
  state,
  surfaces,
  thirdPartyBoundary,
  threadId,
  userId,
  workspaceId,
}: RunChatAttemptProps): AsyncIterable<StreamChunk> {
  // The one place the guard's brands are widened back to the plain types the
  // provider SDK takes: everything below this line is dispatch.
  const {
    messages: preparedMessages,
    system: baseSystem,
    tools: modelTools,
  } = surfaces;
  const caching = resolveCaching({
    promptCachingEnabled,
    role,
    scopeKey: promptCacheKey,
  });
  const analytics = createChatAttemptAnalytics({
    feature,
    modelRole: role,
    organizationId,
    orgAIConfig,
    safeDb,
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
    threadId,
    userId,
    workspaceId,
  });

  const stream = chat({
    adapter: model.adapter,
    messages: preparedMessages,
    tools: projectChatToolSchemasForProvider({
      modelTools,
      provider: model.provider,
    }),
    ...(externalMcpToolSource
      ? {
          mcp: {
            clients: [
              prepareMcpToolSourceForThirdParty({
                boundary: thirdPartyBoundary,
                source: projectMcpToolSourceSchemasForProvider({
                  provider: model.provider,
                  source: externalMcpToolSource,
                }),
              }),
            ],
            connection: "close",
            lazyTools: true,
          },
        }
      : {}),
    agentLoopStrategy: maxIterations(MAX_TOOL_STEPS),
    abortController,
    threadId,
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
        threadId,
      }),
    ],
  });

  yield* stream;
};

type ChatRuntimeMiddlewareProps = {
  abortSignal: AbortSignal;
  baseSystem: string;
  compactionAnalytics: TanStackAIAnalyticsCallbacks;
  compactionFeature: string;
  model: ResolvedTanStackTextModel;
  modelId: string | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  role: ChatAttemptRole;
  state: ChatAttemptState;
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
      case "failed":
      case "interrupted":
        return;
      default:
        event satisfies never;
        return;
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
          patch.systemPrompts = [
            createLoopRecoverySystemPrompt({
              baseSystem,
              detection: loopDetection,
            }),
          ];
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

      if (compactedMessages.value !== config.messages) {
        patch.messages = compactedMessages.value;
      }

      return Object.keys(patch).length === 0 ? undefined : patch;
    },
  };
};

type ProcessServerChatStreamProps = {
  abortSignal: AbortSignal;
  getResponseMessage: () => ChatMessage | null;
  mapMessageId: MessageIdMapper;
  onFinish: (event: StreamChatFinishEvent) => Promise<void> | void;
  processor: StreamProcessor;
  source: AsyncIterable<StreamChunk>;
};

type RunErrorChunk = Extract<StreamChunk, { type: EventType.RUN_ERROR }>;

const runErrorMessage = (chunk: RunErrorChunk): string =>
  chunk.message || "AI stream error";

const errorFromRunErrorChunk = (chunk: RunErrorChunk): Error => {
  const error = new Error(runErrorMessage(chunk));
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

const classifyRunErrorChunk = (chunk: RunErrorChunk): AIErrorKind =>
  classifyAIError(
    chunk.rawEvent ??
      providerErrorBody(runErrorMessage(chunk)) ??
      errorFromRunErrorChunk(chunk),
  );

// Classified kinds (quota, billing, retired model, provider outage) are
// expected operational states; `unknown` means a failure shape this code
// does not anticipate, so it is the only kind logged at ERROR severity.
// Fingerprint only — provider error messages can echo request content.
const reportStreamFailure = (error: unknown, kind: AIErrorKind): void => {
  captureError(error, { kind });
  if (kind === "unknown") {
    logger.error("chat.stream_failed", { kind, ...errorFingerprint(error) });
  }
};

const normalizeRunErrorChunk = (chunk: RunErrorChunk): RunErrorChunk => {
  const kind = classifyRunErrorChunk(chunk);
  reportStreamFailure(errorFromRunErrorChunk(chunk), kind);
  return {
    ...chunk,
    message: kind,
    code: kind,
  };
};

export const processServerChatStream = async function* ({
  abortSignal,
  getResponseMessage,
  mapMessageId,
  onFinish,
  processor,
  source,
}: ProcessServerChatStreamProps): AsyncIterable<StreamChunk> {
  const deferredRunFinishedChunks: StreamChunk[] = [];
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
    if (flushProcessor) {
      finalizeResponseProcessor(processor);
    }
    const responseMessage = createTerminalResponseMessage({
      getResponseMessage,
      mapMessageId,
      outcome,
      usage,
    });
    terminal.state = "settled";
    await onFinish({ outcome, responseMessage });
  };
  try {
    const normalizedSource = ensureAssistantMessageStart({
      getOrCreateMessageId: () =>
        mapMessageId(ASSISTANT_RESPONSE_MESSAGE_ID_SENTINEL),
      source: remapOutgoingMessageIds({
        mapMessageId,
        source,
      }),
    });

    for await (const sourceChunk of normalizedSource) {
      if (sourceChunk.type === EventType.TOOL_CALL_END) {
        toolCallsWithCompleteInput.add(sourceChunk.toolCallId);
      }
      if (
        sourceChunk.type === EventType.RUN_STARTED &&
        deferredRunFinishedChunks.length > 0
      ) {
        // Continuation events such as `approval-requested` belong before the
        // run's finish, but a later run does not. Register the later run with
        // the server-side processor before closing the prior run so the
        // processor keeps the shared assistant message active across a
        // server-tool continuation. The client still receives the canonical
        // FINISH(A), START(B) order. Without this internal overlap, TanStack
        // finalizes after A and a tool-only B has no message-start event to
        // reactivate, so its client-tool call is visible live but omitted from
        // the persisted assistant turn.
        processor.processChunk(sourceChunk);
        const priorRunFinishedChunks = deferredRunFinishedChunks.splice(0);
        for (const chunk of priorRunFinishedChunks) {
          processor.processChunk(chunk);
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
      if (lifecycle === "completed") {
        if (chunk.type !== EventType.RUN_FINISHED) {
          panic("Unhandled TanStack completed stream event");
        }
        if (chunk.usage) {
          usage = chunk.usage;
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
      processor.processChunk(chunk);
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
    const incompleteAskUserInteraction =
      awaitingUserInteraction?.type === "ask-user" &&
      !toolCallsWithCompleteInput.has(awaitingUserInteraction.toolCallId);
    let outcome: ChatTurnOutcome;
    if (incompleteAskUserInteraction) {
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
  getResponseMessage: () => ChatMessage | null;
  mapMessageId: MessageIdMapper;
  outcome: ChatTurnOutcome;
  usage: TokenUsage | undefined;
};

const createTerminalResponseMessage = ({
  getResponseMessage,
  mapMessageId,
  outcome,
  usage,
}: FinishResponseMessageProps): PersistableTerminalAssistantMessage => {
  const responseMessage = getResponseMessage();
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

type MessageIdMapper = (messageId: string) => SafeId<"chatMessage">;

export const createChatMessageIdMapper = (
  createId: () => SafeId<"chatMessage"> = () => createSafeId<"chatMessage">(),
): MessageIdMapper => {
  let responseId: SafeId<"chatMessage"> | null = null;
  return (_messageId) => {
    if (!responseId) {
      responseId = createId();
    }
    return responseId;
  };
};

export const normalizeFinalAssistantMessageId = ({
  mapMessageId,
  message,
}: {
  mapMessageId: MessageIdMapper;
  message: ChatMessage;
}): PersistableChatMessage => {
  const id = mapMessageId(message.id);
  return toPersistableChatMessage({ ...message, id });
};

type RemapOutgoingMessageIdsProps = {
  mapMessageId: MessageIdMapper;
  source: AsyncIterable<StreamChunk>;
};

export const remapOutgoingMessageIds = async function* ({
  mapMessageId,
  source,
}: RemapOutgoingMessageIdsProps): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    yield remapChunkMessageId({ chunk, mapMessageId });
  }
};

type EnsureAssistantMessageStartProps = {
  getOrCreateMessageId: () => SafeId<"chatMessage">;
  source: AsyncIterable<StreamChunk>;
};

export const ensureAssistantMessageStart = async function* ({
  getOrCreateMessageId,
  source,
}: EnsureAssistantMessageStartProps): AsyncIterable<StreamChunk> {
  let hasAssistantMessageStart = false;

  for await (const chunk of source) {
    if (chunk.type === EventType.TEXT_MESSAGE_START) {
      hasAssistantMessageStart = true;
      yield chunk;
      continue;
    }

    if (!hasAssistantMessageStart) {
      const messageId = getAssistantStartMessageId({
        chunk,
        getOrCreateMessageId,
      });
      if (messageId !== null) {
        hasAssistantMessageStart = true;
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          timestamp: Date.now(),
        };
      }
    }

    yield chunk;
  }
};

const getAssistantStartMessageId = ({
  chunk,
  getOrCreateMessageId,
}: {
  chunk: StreamChunk;
  getOrCreateMessageId: () => SafeId<"chatMessage">;
}): string | null => {
  if (hasMessageId(chunk)) {
    return chunk.messageId;
  }

  if (chunk.type === EventType.TOOL_CALL_START) {
    return typeof chunk.parentMessageId === "string"
      ? chunk.parentMessageId
      : getOrCreateMessageId();
  }

  if (chunk.type === EventType.STEP_FINISHED) {
    return getOrCreateMessageId();
  }

  return null;
};

type StreamChunkWithMessageId = StreamChunk & { messageId: string };

const hasMessageId = (chunk: StreamChunk): chunk is StreamChunkWithMessageId =>
  "messageId" in chunk && typeof chunk.messageId === "string";

const remapChunkMessageId = ({
  chunk,
  mapMessageId,
}: {
  chunk: StreamChunk;
  mapMessageId: MessageIdMapper;
}): StreamChunk => {
  const remappedChunk = hasMessageId(chunk)
    ? { ...chunk, messageId: mapMessageId(chunk.messageId) }
    : chunk;

  const remappedParentChunk =
    "parentMessageId" in remappedChunk &&
    typeof remappedChunk.parentMessageId === "string"
      ? {
          ...remappedChunk,
          parentMessageId: mapMessageId(remappedChunk.parentMessageId),
        }
      : remappedChunk;

  if (
    remappedParentChunk.type !== EventType.CUSTOM ||
    !isRecord(remappedParentChunk.value)
  ) {
    return remappedParentChunk;
  }

  const messageId = remappedParentChunk.value["messageId"];
  if (typeof messageId !== "string") {
    return remappedParentChunk;
  }

  return {
    ...remappedParentChunk,
    value: {
      ...remappedParentChunk.value,
      messageId: mapMessageId(messageId),
    },
  };
};

type TransformOutgoingStreamProps = {
  boundary: ChatThirdPartyBoundary;
  initialRestorationPlaceholders: ReadonlySet<string>;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  restorationPairs: ChatAnonRestoration[];
  source: AsyncIterable<StreamChunk>;
};

export const transformOutgoingStream = async function* ({
  boundary,
  initialRestorationPlaceholders,
  resolveAssistantTextRefs,
  resolveAssistantValueRefs,
  restorationPairs,
  source,
}: TransformOutgoingStreamProps): AsyncIterable<StreamChunk> {
  const transform = createOutgoingChunkTransformer({
    boundary,
    initialRestorationPlaceholders,
    resolveAssistantTextRefs,
    resolveAssistantValueRefs,
    restorationPairs,
  });

  for await (const chunk of source) {
    for (const transformed of transform(chunk)) {
      yield transformed;
    }
  }

  for (const flushed of transform.flush()) {
    yield flushed;
  }
};

type OutgoingChunkTransformerOptions = {
  boundary: ChatThirdPartyBoundary;
  initialRestorationPlaceholders: ReadonlySet<string>;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  restorationPairs: ChatAnonRestoration[];
};

const createOutgoingChunkTransformer = ({
  boundary,
  initialRestorationPlaceholders,
  resolveAssistantTextRefs,
  resolveAssistantValueRefs,
  restorationPairs,
}: OutgoingChunkTransformerOptions) => {
  const buffers = new Map<string, string>();
  const emittedPlaceholders = new Set(initialRestorationPlaceholders);
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

  const transform = (chunk: StreamChunk): StreamChunk[] => {
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
      let input: unknown;
      if ("input" in chunk) {
        input =
          boundary.type === "anonymized"
            ? deanonymizeUnknownStringsFromBoundary(
                boundary,
                chunk.input,
                "lenient",
              )
            : chunk.input;
      }
      return [
        ...flushToolArguments({
          text: pending,
          toolCallId: chunk.toolCallId,
        }),
        input === undefined ? chunk : { ...chunk, input },
      ];
    }

    if (chunk.type === EventType.TOOL_CALL_RESULT) {
      const result = transformToolResultContent({
        boundary,
        content: chunk.content,
        lenientCollector,
        resolveAssistantValueRefs,
      });
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
      const input =
        boundary.type === "anonymized"
          ? deanonymizeUnknownStringsFromBoundary(boundary, rawInput, "lenient")
          : rawInput;
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

type ParsedToolResultContent =
  | { type: "json"; value: unknown }
  | { type: "text"; value: string };

type TransformToolResultContentOptions = {
  boundary: ChatThirdPartyBoundary;
  content: string;
  lenientCollector: LenientPlaceholderCollector | null;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
};

type TransformToolResultContentResult = {
  content: string;
  placeholders: ReadonlySet<string>;
};

const transformToolResultContent = ({
  boundary,
  content,
  lenientCollector,
  resolveAssistantValueRefs,
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
  const resolvedValue = resolveAssistantValueRefs
    ? resolveAssistantValueRefs(visibleValue)
    : visibleValue;

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

        parts.push(hydratedPart.part);
      }

      hydratedMessages.push({
        ...message,
        parts,
      });
    }

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
