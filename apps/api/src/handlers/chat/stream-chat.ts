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

import {
  resolveStellaSandboxRun,
  type StellaSandboxRunInput,
} from "@stll/agent-engine";
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
  getChatAttachmentMimeType,
  getUserFileIdFromAttachmentPart,
  isChatPart,
  isChatAttachmentPart,
  isChatDocumentPart,
} from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatSafePrompt,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
import { resolveChatSandboxPlan } from "@/api/handlers/chat/chat-sandbox-plan";
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
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import {
  deanonymizeFromBoundary,
  deanonymizeUnknownStringsFromBoundary,
  prepareMessagesForThirdParty,
  prepareMcpToolSourceForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
} from "@/api/handlers/chat/third-party-boundary";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  chatToolMapToArray,
  type ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { StellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import type {
  ChatAnonRestoration,
  ChatMessage,
  ChatMessageUsage,
  ChatPart,
  PersistableChatMessage,
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
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
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
  isAborted: boolean;
  responseMessage: PersistableChatMessage;
};

type StreamChatProps = {
  agentWorkspaceIds: AuthorizedToolWorkspaceIds;
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
  /**
   * Explicit per-turn execution mode from the request (`body.runMode`).
   * `"agent"` opts this turn into an agent-sandbox run; undefined (the default
   * for every normal chat) keeps the server-side model path. Gating the
   * sandbox plan on this makes it structurally impossible for a normal/BYOK
   * chat to be rerouted just because the sandbox engine is enabled.
   */
  runMode: ChatRunMode | undefined;
  resolveAssistantTextRefs?: ((text: string) => string) | undefined;
  resolveAssistantValueRefs?: AssistantValueRefResolver | undefined;
  safeDb: SafeDb;
  systemSafe: ChatSafePrompt;
  systemUntrusted: ChatUntrustedPromptSuffix;
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

    const parts = message.parts.filter(
      (part) =>
        part.type !== "tool-call" ||
        part.state === "complete" ||
        part.state === "input-complete" ||
        part.state === "approval-responded" ||
        part.output !== undefined,
    );
    return parts.length === message.parts.length
      ? message
      : { ...message, parts };
  });

export const streamChat = async ({
  agentWorkspaceIds,
  abortSignal,
  devModelId,
  latestMessageId,
  messages: rawMessages,
  onFinish,
  organizationId,
  orgAIConfig,
  promptCacheKey,
  promptCachingEnabled,
  runMode,
  resolveAssistantTextRefs,
  resolveAssistantValueRefs,
  safeDb,
  systemSafe,
  systemUntrusted,
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

  const preparedMessages = await prepareMessagesForThirdParty({
    boundary: thirdPartyBoundary,
    messages,
  });
  if (Result.isError(preparedMessages)) {
    return thirdPartyBoundaryRefusalResponse(preparedMessages.error);
  }

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
  const documentAttachmentMimeTypes = preparedMessages.value.flatMap(
    (message) =>
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
  const modelTools = chatToolMapToArray(
    prepareToolsForThirdParty({ boundary: thirdPartyBoundary, tools }),
  );
  const restorationPairs: ChatAnonRestoration[] = [];
  const mapAssistantMessageId = createChatMessageIdMapper();
  let responseMessage: ChatMessage | null = null;
  const processor = new StreamProcessor({
    initialMessages: preparedMessages.value,
    events: {
      onStreamEnd: (message) => {
        responseMessage = attachRestorationMetadata({
          message: toChatMessage(message),
          restorationPairs,
        });
      },
    },
  });

  const stream = runChatAttempts({
    agentWorkspaceIds,
    abortController,
    abortSignal,
    baseSystem: system,
    devModelId,
    externalMcpToolSource,
    fallbackModel,
    modelTools,
    organizationId,
    orgAIConfig,
    preparedMessages: preparedMessages.value,
    primaryModel,
    promptCacheKey,
    promptCachingEnabled,
    runMode,
    safeDb,
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
              messages: preparedMessages.value,
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
): ChatLoopDetectedError | ChatEmptyCompletionError | null =>
  state.finalLoopDetection ?? state.emptyCompletion;

type ShouldAttemptChatFallbackInput = {
  hasFallbackModel: boolean;
  primaryError: ChatLoopDetectedError | ChatEmptyCompletionError;
  runMode: ChatRunMode | undefined;
};

export const shouldAttemptChatFallback = ({
  hasFallbackModel,
  primaryError,
  runMode,
}: ShouldAttemptChatFallbackInput): boolean =>
  runMode !== CHAT_RUN_MODE.agent &&
  primaryError instanceof ChatEmptyCompletionError &&
  hasFallbackModel;

export const projectChatToolSchemasForProvider = ({
  modelTools,
  provider,
}: {
  modelTools: ReturnType<typeof chatToolMapToArray>;
  provider: string;
}): ReturnType<typeof chatToolMapToArray> => {
  const projectionOptions =
    providerSafeJsonSchemaOptionsForTanStackProvider(provider);
  const projectedTools: ReturnType<typeof chatToolMapToArray> = [];
  for (const tool of modelTools) {
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

const projectServerToolsForProvider = ({
  provider,
  serverTools,
}: {
  provider: string;
  serverTools: readonly ServerTool[];
}): ServerTool[] => {
  const projectionOptions =
    providerSafeJsonSchemaOptionsForTanStackProvider(provider);
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

type RunChatAttemptsProps = {
  agentWorkspaceIds: AuthorizedToolWorkspaceIds;
  abortController: AbortController;
  abortSignal: AbortSignal;
  baseSystem: string;
  devModelId: string | undefined;
  externalMcpToolSource: StellaMcpToolSource | undefined;
  fallbackModel: ResolvedTanStackTextModel | null;
  modelTools: ReturnType<typeof chatToolMapToArray>;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  preparedMessages: ChatMessage[];
  primaryModel: ResolvedTanStackTextModel;
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  runMode: ChatRunMode | undefined;
  safeDb: SafeDb;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const runChatAttempts = async function* ({
  agentWorkspaceIds,
  abortController,
  abortSignal,
  baseSystem,
  devModelId,
  externalMcpToolSource,
  fallbackModel,
  modelTools,
  organizationId,
  orgAIConfig,
  preparedMessages,
  primaryModel,
  promptCacheKey,
  promptCachingEnabled,
  runMode,
  safeDb,
  thirdPartyBoundary,
  threadId,
  userId,
  workspaceId,
}: RunChatAttemptsProps): AsyncIterable<StreamChunk> {
  const primaryState = createChatAttemptState();
  // Only an explicit agent-run request resolves a sandbox plan. A normal chat
  // (runMode undefined) is never rerouted, even when the sandbox engine is
  // enabled — so BYOK/model-selected turns keep the user's chosen adapter.
  const sandboxRun =
    runMode === CHAT_RUN_MODE.agent
      ? await resolveChatSandboxPlan({
          userId,
          organizationId,
          runId: Bun.randomUUIDv7(),
          workspaceIds: agentWorkspaceIds,
        })
      : undefined;
  yield* runChatAttempt({
    abortController,
    abortSignal,
    baseSystem,
    compactionFeature: "chat.step_compaction",
    externalMcpToolSource,
    feature: "chat.stream",
    model: primaryModel,
    modelId: devModelId,
    modelTools,
    organizationId,
    orgAIConfig,
    preparedMessages,
    promptCacheKey,
    promptCachingEnabled,
    role: "chat",
    safeDb,
    sandboxRun,
    state: primaryState,
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
    baseSystem,
    compactionFeature: "chat.step_compaction_fallback",
    externalMcpToolSource,
    feature: "chat.stream_fallback",
    model: fallbackModel,
    modelId: undefined,
    modelTools,
    organizationId,
    orgAIConfig,
    preparedMessages,
    promptCacheKey,
    promptCachingEnabled,
    role: "reasoning",
    safeDb,
    state: fallbackState,
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
  baseSystem: string;
  compactionFeature: string;
  externalMcpToolSource: StellaMcpToolSource | undefined;
  feature: string;
  model: ResolvedTanStackTextModel;
  modelId: string | undefined;
  modelTools: ReturnType<typeof chatToolMapToArray>;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  preparedMessages: ChatMessage[];
  promptCacheKey: string;
  promptCachingEnabled: boolean;
  role: ChatAttemptRole;
  safeDb: SafeDb;
  /**
   * When set, this attempt runs inside an agent sandbox (plan 050): the
   * harness adapter replaces the model adapter and the sandbox middleware is
   * added. When absent (the default for every normal chat), the attempt is
   * unchanged. Explicit agent runs never fall back to a plain server-side
   * model attempt.
   */
  sandboxRun?: StellaSandboxRunInput | undefined;
  state: ChatAttemptState;
  thirdPartyBoundary: ChatThirdPartyBoundary;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const runChatAttempt = async function* ({
  abortController,
  abortSignal,
  baseSystem,
  compactionFeature,
  externalMcpToolSource,
  feature,
  model,
  modelId,
  modelTools,
  organizationId,
  orgAIConfig,
  preparedMessages,
  promptCacheKey,
  promptCachingEnabled,
  role,
  safeDb,
  sandboxRun,
  state,
  thirdPartyBoundary,
  threadId,
  userId,
  workspaceId,
}: RunChatAttemptProps): AsyncIterable<StreamChunk> {
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

  if (sandboxRun) {
    // Agent-sandbox attempt (plan 050): the harness adapter drives the run and
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
    // `baseSystem` stays wired below for loop-recovery parity; enriching the
    // harness instructions with curated workspace context is a follow-up.
    const { adapter, middleware: sandboxMiddleware } =
      resolveStellaSandboxRun(sandboxRun);
    yield* chat({
      adapter,
      messages: preparedMessages,
      agentLoopStrategy: maxIterations(MAX_TOOL_STEPS),
      abortController,
      threadId,
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
        sandboxMiddleware,
      ],
    });
    return;
  }

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
  return {
    name: "stella-chat-runtime",
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
    onFinish: (ctx, info) => {
      recordChatAttemptFinish({
        finishReason: info.finishReason,
        messages: ctx.messages,
        modelInfo: model,
        state,
        threadId,
        usage: info.usage,
      });
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

const classifyRunErrorChunk = (chunk: RunErrorChunk): AIErrorKind =>
  classifyAIError(chunk.rawEvent ?? errorFromRunErrorChunk(chunk));

const normalizeRunErrorChunk = (chunk: RunErrorChunk): RunErrorChunk => {
  const kind = classifyRunErrorChunk(chunk);
  captureError(errorFromRunErrorChunk(chunk), { kind });
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
  let usage: TokenUsage | undefined;
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
      const chunk =
        sourceChunk.type === EventType.RUN_ERROR
          ? normalizeRunErrorChunk(sourceChunk)
          : sourceChunk;
      if (chunk.type === EventType.RUN_FINISHED && chunk.usage) {
        usage = chunk.usage;
      }
      processor.processChunk(chunk);
      if (chunk.type === EventType.RUN_FINISHED) {
        deferredRunFinishedChunks.push(chunk);
        continue;
      }
      yield chunk;
      if (chunk.type === EventType.RUN_ERROR) {
        return;
      }
    }

    await finishResponseMessage({
      abortSignal,
      getResponseMessage,
      mapMessageId,
      onFinish,
      usage,
    });
    for (const chunk of deferredRunFinishedChunks) {
      yield chunk;
    }
  } catch (error) {
    const kind = classifyAIError(error);
    captureError(error, { kind });
    if (abortSignal.aborted) {
      await finishAbortedResponseMessage({
        abortSignal,
        getResponseMessage,
        mapMessageId,
        onFinish,
        processor,
        usage,
      });
    }
    yield {
      type: EventType.RUN_ERROR,
      message: kind,
      code: kind,
      timestamp: Date.now(),
    };
  }
};

type FinishResponseMessageProps = {
  abortSignal: AbortSignal;
  getResponseMessage: () => ChatMessage | null;
  mapMessageId: MessageIdMapper;
  onFinish: (event: StreamChatFinishEvent) => Promise<void> | void;
  usage: TokenUsage | undefined;
};

const finishResponseMessage = async ({
  abortSignal,
  getResponseMessage,
  mapMessageId,
  onFinish,
  usage,
}: FinishResponseMessageProps): Promise<void> => {
  const responseMessage = getResponseMessage();
  if (!responseMessage) {
    return;
  }

  await onFinish({
    isAborted: abortSignal.aborted,
    responseMessage: attachUsageMetadata({
      message: normalizeFinalAssistantMessageId({
        mapMessageId,
        message: responseMessage,
      }),
      usage,
    }),
  });
};

type FinishAbortedResponseMessageProps = FinishResponseMessageProps & {
  processor: StreamProcessor;
};

const finishAbortedResponseMessage = async ({
  processor,
  ...props
}: FinishAbortedResponseMessageProps): Promise<void> => {
  try {
    processor.finalizeStream();
    await finishResponseMessage(props);
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
  return { ...message, id };
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

const toChatMessage = (message: UIMessage): ChatMessage => ({
  id: message.id,
  role: message.role,
  parts: toChatParts(message.parts),
});

const toChatParts = (
  parts: readonly UIMessage["parts"][number][],
): ChatPart[] => {
  const chatParts: ChatPart[] = [];
  for (const part of parts) {
    if (!isChatPart(part)) {
      panic("TanStack stream emitted an unsupported chat part");
    }
    chatParts.push(part);
  }
  return chatParts;
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
    // SAFETY: bounded by the `id IN (ids)` set; ids are the distinct user-file ids collected from the message parts (userFiles.id is the PK).
    // eslint-disable-next-line require-query-limit/require-query-limit
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
