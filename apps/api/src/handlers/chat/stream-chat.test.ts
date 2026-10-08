import {
  chat,
  EventType,
  maxIterations,
  normalizeStreamChunk,
  RUN_CANCEL_REASON,
  StreamProcessor,
  toolDefinition,
} from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  ModelMessage,
  StreamChunk,
  TokenUsage,
  ToolCallPart,
  UIMessage,
} from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { panic, Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { createPipelineContext } from "@stll/anonymize";
import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";
import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";
import {
  VISUAL_PREVIEW_TOOL_NAME,
  visualPreviewToolOutputSchema,
  type VisualPreviewOutput,
} from "@stll/api-contract/visual-preview";

import {
  createChatAttachmentPart,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  CHAT_RUN_MODE,
  validateToolCallParts,
} from "@/api/handlers/chat/chat-schema";
import { cutShortAssistantMessage } from "@/api/handlers/chat/chat-turn-persistence";
import { CHAT_TURN_OWNER_LOST_REASON } from "@/api/handlers/chat/chat-turn-run";
import {
  findUnsettledStoredToolCalls,
  settleHistoryForRun,
} from "@/api/handlers/chat/chat-turn-settlement";
import {
  COMPACTION_SUMMARY_MESSAGE_ID,
  createCompactionSummaryMessage,
} from "@/api/handlers/chat/compaction";
import { guardProviderHistory } from "@/api/handlers/chat/provider-history";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { createAutoApplySuggestChangesTools } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import { SUGGEST_CHANGES_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import { resolveRegistryToolInputRefs } from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import { resolveRegistryToolOutputRefs } from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
import { createSpawnSubagentsTool } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type {
  ChatAnonRestoration,
  ChatMessage,
} from "@/api/handlers/chat/types";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { ChatTool } from "@/api/lib/chat/chat-tool-types";
import {
  guardModelMessages,
  guardModelSystemPrompt,
  guardModelToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  DatabaseError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { abortControllerFromSignal } from "@/api/lib/tanstack-ai-generate";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { visualPreviewModelContent } from "@/api/lib/visual-preview";
import { projectVisualPreviewStream } from "@/api/lib/visual-preview-stream";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import {
  buildEngineSnapshot,
  buildWireSnapshot,
  unsafeFixture,
} from "@/api/tests/helpers/chat-fixtures";
import { memberDocumentWriteAccess } from "@/api/tests/helpers/document-write-access";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { richChatParts } from "./__fixtures__/rich-chat-parts";
import { buildGlobalPromptParts } from "./chat-prompt";
import type { GuardedChatSurfaces } from "./stream-chat";
import {
  chatMessageUsageFromTokenUsage,
  chatTurnRejectsStreamingTools,
  collectInitialRestorationPlaceholders,
  createChatAttemptState,
  hydrateMessages,
  processServerChatStream,
  pruneOrphanedToolParts,
  prepareResumeForThirdParty,
  recordChatAttemptFinish,
  toChatMessage,
  resolveAgentRunBoundaryError,
  shouldAttemptChatFallback,
  transformClientVisibleStream,
  transformOutgoingStream,
  transformPersistenceVisibleStream,
} from "./stream-chat";
import {
  createChatMessageIdMapper,
  createTurnMessageIdMapper,
  ensureAssistantMessageStart,
  findDeniedApprovals,
  normalizeFinalAssistantMessageId,
  remapOutgoingMessageIds,
} from "./stream-message-identity";
import type { MessageIdMapper, StoredHistory } from "./stream-message-identity";

/** A run whose history the engine holds exactly as stored. */
const NOTHING_REWRITTEN: StoredHistory = {
  loadServed: async () => await Promise.resolve(Result.ok(new Map())),
  rewrittenOnAcceptance: [],
};

const collectChunks = async (
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

const collectText = (chunks: readonly StreamChunk[]) => {
  let text = "";
  for (const chunk of chunks) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      text += chunk.delta;
    }
  }
  return text;
};

const collectReasoning = (chunks: readonly StreamChunk[]) => {
  let text = "";
  for (const chunk of chunks) {
    if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) {
      text += chunk.delta;
    }
  }
  return text;
};

const stripTimestamps = (chunks: readonly StreamChunk[]) =>
  chunks.map((chunk) => {
    const { timestamp, ...rest } = chunk;
    void timestamp;
    return rest;
  });

describe("tool-call history pruning", () => {
  test("drops partial calls while retaining resumable and terminal calls", () => {
    const states = ["input-streaming", "input-complete", "error"] as const;
    const message = {
      id: "assistant-1",
      parts: states.map((state) => ({
        arguments: "{}",
        id: `tool-${state}`,
        name: "web_search",
        state,
        type: "tool-call" as const,
      })),
      role: "assistant" as const,
    } satisfies ChatMessage;

    const prunedMessage = pruneOrphanedToolParts([message]).at(0);

    expect(
      prunedMessage?.parts.flatMap((part) =>
        part.type === "tool-call" ? [part.state] : [],
      ),
    ).toEqual(["input-complete", "error"]);
  });
});

describe("streaming tool-use capability gate", () => {
  test("allows a tool-carrying turn on a model that streams tools", () => {
    expect(
      chatTurnRejectsStreamingTools({
        model: { modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
        toolCount: 12,
      }),
    ).toBe(false);
  });

  test("allows an uncatalogued model rather than stripping its tools", () => {
    expect(
      chatTurnRejectsStreamingTools({
        model: { modelId: "some-env-override-model" },
        toolCount: 12,
      }),
    ).toBe(false);
  });
});

describe("agent sandbox third-party boundary", () => {
  test("refuses raw MCP access in anonymized mode", () => {
    const error = resolveAgentRunBoundaryError({
      boundary: { type: CHAT_SEND_MODE.anonymized },
      runMode: CHAT_RUN_MODE.agent,
    });

    expect(error).toMatchObject({
      code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
      status: 422,
    });
  });

  test("allows an explicit agent run at the raw boundary", () => {
    expect(
      resolveAgentRunBoundaryError({
        boundary: { type: "raw" },
        runMode: CHAT_RUN_MODE.agent,
      }),
    ).toBeNull();
  });
});

/**
 * A text adapter that answers every model turn with one tool call. Driving the
 * real `chat()` loop with it derives TanStack's interrupt boundary emission
 * (MESSAGES_SNAPSHOT, then RUN_FINISHED with an `interrupt` outcome) instead of
 * hand-writing the sequence, so the persistence path is checked against what
 * the loop actually emits.
 */
type ScriptedToolCallTurn = {
  arguments: string;
  /**
   * What the adapter hands the engine on `TOOL_CALL_END` after undoing
   * provider-side reshaping of `arguments` (OpenAI strict-mode null widening).
   */
  input?: Record<string, unknown> | undefined;
  toolName: string;
};

const createSingleToolCallAdapter = (
  turn: ScriptedToolCallTurn,
): AnyTextAdapter => createToolCallSequenceAdapter([turn]);

/**
 * Answers the n-th model turn with the n-th tool call, so a run can execute a
 * server tool first and pause for a client tool on the next iteration.
 */
const createToolCallSequenceAdapter = (
  turns: readonly ScriptedToolCallTurn[],
): AnyTextAdapter => {
  let turnIndex = 0;
  return createScriptedAdapter(turns, () => {
    const index = turnIndex;
    turnIndex += 1;
    return index;
  });
};

const createScriptedAdapter = (
  turns: readonly ScriptedToolCallTurn[],
  nextTurnIndex: () => number,
): AnyTextAdapter => ({
  kind: "text",
  name: "single-tool-call",
  model: "single-tool-call",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ model, runId, threadId }) {
    const turnIndex = nextTurnIndex();
    const turn = turns.at(turnIndex);
    if (turn === undefined) {
      throw new Error("The fixture adapter ran out of scripted turns");
    }
    const { arguments: argumentsText, input, toolName } = turn;
    const callId = `call-${String(turnIndex + 1)}`;
    const resolvedRunId = runId ?? "run-1";
    const resolvedThreadId = threadId ?? "thread-1";
    const messageId = `provider-message-${String(turnIndex + 1)}`;
    const timestamp = Date.now();
    yield {
      type: EventType.RUN_STARTED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    // Provider adapters open a text message only when text arrives; a
    // tool-only iteration (Gemini, OpenAI Responses) carries no
    // TEXT_MESSAGE_START, so only the first scripted turn emits one.
    if (turnIndex === 0) {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        model,
        timestamp,
      } satisfies AdapterYieldChunk;
    }
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: callId,
      toolCallName: toolName,
      parentMessageId: messageId,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: callId,
      delta: argumentsText,
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId: callId,
      ...(input === undefined ? {} : { input }),
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      finishReason: "tool_calls",
      model,
      timestamp,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } satisfies AdapterYieldChunk;
  },
  structuredOutput: () => {
    throw new Error("Structured output is not part of this fixture");
  },
});

/** Answers the model turn with one text reply, as a model reading a tool result does. */
const createTextReplyAdapter = (text: string): AnyTextAdapter => ({
  kind: "text",
  name: "text-reply",
  model: "text-reply",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ model, runId, threadId }) {
    const resolvedRunId = runId ?? "run-1";
    const resolvedThreadId = threadId ?? "thread-1";
    const messageId = "provider-reply";
    const timestamp = Date.now();
    yield {
      type: EventType.RUN_STARTED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: text,
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      model,
      timestamp,
    } satisfies AdapterYieldChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      finishReason: "stop",
      model,
      timestamp,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } satisfies AdapterYieldChunk;
  },
  structuredOutput: () => {
    throw new Error("Structured output is not part of this fixture");
  },
});

const draftToolInputSchema = toTanStackToolSchema(
  v.object({ name: v.string(), source: v.string() }),
);

type ProcessedStreamFinishEvent = Parameters<
  Parameters<typeof processServerChatStream>[0]["onFinish"]
>[0];

/** The two signals `streamChat` hands the processor: the run's own, and the
 *  metered provider deadline it was derived from. */
type TurnSignals = {
  abortSignal: AbortSignal;
  deadlineSignal: AbortSignal;
  runSignal?: AbortSignal;
  teardownAfterSourceChunks?: number;
  getRestorableCheckpoint?: () =>
    | ReturnType<typeof toPersistableChatMessage>
    | undefined;
};

const uncutTurnSignals = (): TurnSignals => {
  const deadline = new AbortController();
  return {
    abortSignal: abortControllerFromSignal(deadline.signal).signal,
    deadlineSignal: deadline.signal,
  };
};

/** Run the loop's emission through the same persistence path as `streamChat`. */
const persistNativeInterruptTurn = async (
  chunks: AsyncIterable<StreamChunk>,
  signals: TurnSignals = uncutTurnSignals(),
) => {
  const { teardownAfterSourceChunks, ...streamSignals } = signals;
  const messageId = toSafeId<"chatMessage">(
    "11111111-1111-4111-8111-111111111111",
  );
  const mapMessageId = createChatMessageIdMapper(() => messageId);
  let responseMessage: ChatMessage | null = null;
  const processor = new StreamProcessor({
    events: {
      onStreamEnd: (message) => {
        responseMessage = toChatMessage(message);
      },
    },
  });
  const terminal: { finish: ProcessedStreamFinishEvent | null } = {
    finish: null,
  };
  const source: StreamChunk[] = [];
  const observed = async function* (): AsyncIterable<StreamChunk> {
    for await (const chunk of chunks) {
      source.push(chunk);
      yield chunk;
    }
  };
  const output = processServerChatStream({
    ...streamSignals,
    getResponseMessage: () => responseMessage,
    initialMessages: [],
    mapMessageId,
    onFinish: (event) => {
      terminal.finish = event;
    },
    processor,
    source: observed(),
  });
  const emitted: StreamChunk[] = [];
  for await (const chunk of output) {
    emitted.push(chunk);
    if (
      teardownAfterSourceChunks !== undefined &&
      source.length >= teardownAfterSourceChunks
    ) {
      break;
    }
  }
  return { emitted, finish: terminal.finish, source };
};

test("transient visual preview reaches the in-turn model but not wire, persistence or reload", async () => {
  const preview = {
    png: "iVBORw0KGgo=",
    consoleErrors: ["Example diagnostic"],
    blockedRequests: 1,
    size: { width: 1200, height: 200 },
    readyFired: true,
  } satisfies VisualPreviewOutput;
  const output = visualPreviewModelContent({ title: "Example", preview });
  const scripted = createToolCallSequenceAdapter([
    { toolName: VISUAL_PREVIEW_TOOL_NAME, arguments: "{}" },
    { toolName: "finish_preview", arguments: "{}" },
  ]);
  const observed: { modelMessages: ModelMessage[] | null; calls: number } = {
    modelMessages: null,
    calls: 0,
  };
  const adapter = {
    ...scripted,
    async *chatStream(options) {
      if (options.messages.some((message) => message.role === "tool")) {
        observed.modelMessages = structuredClone(options.messages);
      }
      yield* scripted.chatStream(options);
    },
  } satisfies AnyTextAdapter;
  const visualTool = toolDefinition({
    name: VISUAL_PREVIEW_TOOL_NAME,
    description: "Return the visual preview fixture",
    inputSchema: toTanStackToolSchema(v.strictObject({})),
    outputSchema: toTanStackToolSchema(visualPreviewToolOutputSchema),
  }).server(() => {
    observed.calls += 1;
    return output;
  });
  const finishTool = toolDefinition({
    name: "finish_preview",
    description: "Pause after checking the visual",
    inputSchema: toTanStackToolSchema(v.strictObject({})),
  }).client();
  const withDuplicateResult = async function* (
    chunks: AsyncIterable<PublicStreamChunk>,
  ): AsyncIterable<PublicStreamChunk> {
    for await (const chunk of chunks) {
      if (
        chunk.type === EventType.TOOL_CALL_END &&
        chunk.toolCallId === "call-1"
      ) {
        const duplicate = {
          ...chunk,
          output,
          result: output,
          metadata: { tanstack: { output, result: output } },
        };
        yield duplicate;
        continue;
      }
      if (
        chunk.type === EventType.TOOL_CALL_RESULT &&
        chunk.toolCallId === "call-1"
      ) {
        const duplicate = {
          ...chunk,
          result: output,
          metadata: {
            tanstack: {
              result: output,
              toolResult: { content: output, result: output },
            },
          },
        };
        yield duplicate;
        continue;
      }
      if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
        yield {
          ...chunk,
          messages: chunk.messages.map((message) =>
            message.role === "tool" && message.toolCallId === "call-1"
              ? {
                  ...message,
                  metadata: {
                    tanstack: {
                      result: output,
                      toolResult: { content: output, result: output },
                    },
                  },
                }
              : message,
          ),
        };
        continue;
      }
      yield chunk;
    }
  };
  const { emitted, finish, source } = await persistNativeInterruptTurn(
    projectVisualPreviewStream(
      withDuplicateResult(
        chat({
          adapter,
          tools: [visualTool, finishTool],
          messages: [{ role: "user", content: "Show the example" }],
          agentLoopStrategy: maxIterations(3),
          threadId: "preview-thread",
        }),
      ),
    ),
  );
  expect(observed.calls).toBe(1);
  expect(
    observed.modelMessages?.find((message) => message.role === "tool")?.content,
  ).toEqual(output);
  expect(
    source.some((chunk) => chunk.type === EventType.MESSAGES_SNAPSHOT),
  ).toBe(true);
  expect(JSON.stringify(emitted)).not.toContain(preview.png);
  expect(JSON.stringify(emitted)).not.toContain('"type":"image"');
  expect(JSON.stringify(emitted)).toContain("screenshot omitted from history");
  if (finish === null) {
    throw new Error("Expected preview turn persistence");
  }
  const persisted = toPersistedChatMessageContentV3({
    data: finish.responseMessage.parts,
  });
  const reloaded = normalizePersistedChatMessageContent(persisted);
  expect(JSON.stringify(persisted)).not.toContain(preview.png);
  expect(JSON.stringify(persisted)).not.toContain('"type":"image"');
  expect(JSON.stringify(reloaded)).not.toContain(preview.png);
  expect(JSON.stringify(reloaded)).not.toContain('"type":"image"');
  expect(JSON.stringify(reloaded)).toContain("screenshot omitted from history");
  expect(JSON.stringify(reloaded)).toContain("Example diagnostic");
  const fields: unknown[] = [source, emitted, persisted, reloaded];
  let enumeratedStrings = 0;
  while (fields.length > 0) {
    const field = fields.pop();
    if (typeof field === "string") {
      enumeratedStrings += 1;
      expect(field).not.toContain("iVBOR");
      continue;
    }
    if (Array.isArray(field)) {
      fields.push(...field);
      continue;
    }
    if (typeof field === "object" && field !== null) {
      fields.push(...Object.values(field));
    }
  }
  expect(enumeratedStrings).toBeGreaterThan(0);
  const settled = settleHistoryForRun({
    messages: [
      {
        ...finish.responseMessage,
        parts: reloaded.parts.filter(
          (part) =>
            (part.type === "tool-call" && part.id === "call-1") ||
            (part.type === "tool-result" && part.toolCallId === "call-1"),
        ),
      },
    ],
    resumedMessageId: undefined,
  });
  const settledMessage = settled.at(0);
  if (settledMessage === undefined) {
    throw new Error("Expected settled preview message");
  }
  const previewCall = settledMessage.parts.find(
    (part) => part.type === "tool-call" && part.id === "call-1",
  );
  if (previewCall?.type !== "tool-call") {
    throw new Error("Expected settled preview output");
  }
  expect(
    v.safeParse(visualPreviewToolOutputSchema, previewCall.output).success,
  ).toBe(true);
  validateToolCallParts({
    message: settledMessage,
    tools: { [VISUAL_PREVIEW_TOOL_NAME]: visualTool },
  }).unwrap();
  expect(JSON.stringify(settledMessage)).not.toContain(preview.png);
  expect(output).toHaveLength(2);
});

describe("transient visual preview fault persistence", () => {
  for (const fault of ["error-event", "source-error", "abort"] as const) {
    for (const cut of ["before-result", "partial-result"] as const) {
      test(`${fault} at ${cut} persists no screenshot and settles the turn`, async () => {
        const abort = new AbortController();
        const deadline = new AbortController();
        const terminalError = {
          type: EventType.RUN_ERROR,
          message: "provider_unavailable",
          code: "provider_unavailable",
        } as const;
        const partial = { png: "iVBORw0KGgo=", readyFired: true };
        const lifecycle = { closed: false };
        const source = async function* (): AsyncIterable<PublicStreamChunk> {
          try {
            yield {
              type: EventType.RUN_STARTED,
              runId: "preview-run",
              threadId: "preview-thread",
            };
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "preview-message",
              role: "assistant",
            };
            yield {
              type: EventType.TOOL_CALL_START,
              toolCallId: "preview-call",
              toolCallName: VISUAL_PREVIEW_TOOL_NAME,
            };
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: "preview-call",
              delta: "{}",
            };
            yield* normalizeStreamChunk({
              type: EventType.TOOL_CALL_END,
              toolCallId: "preview-call",
              toolName: VISUAL_PREVIEW_TOOL_NAME,
              output: partial,
              input: {},
            });
            if (cut === "partial-result") {
              yield {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: "preview-call",
                messageId: "preview-message",
                content: `[{"type":"image","source":{"type":"data","value":"${partial.png}"`,
              };
            }
            if (fault === "error-event") {
              yield terminalError;
              return;
            }
            if (fault === "abort") {
              abort.abort("Preview source aborted");
              throw new DOMException("Preview source aborted", "AbortError");
            }
            throw new Error("Preview source failed");
          } finally {
            lifecycle.closed = true;
          }
        };
        const {
          emitted,
          finish,
          source: projected,
        } = await persistNativeInterruptTurn(
          projectVisualPreviewStream(source()),
          { abortSignal: abort.signal, deadlineSignal: deadline.signal },
        );
        expect(lifecycle.closed).toBe(true);
        expect(JSON.stringify(emitted)).not.toContain(partial.png);
        if (fault === "error-event") {
          expect(
            projected.find((chunk) => chunk.type === EventType.RUN_ERROR),
          ).toBe(terminalError);
        }
        if (finish === null) {
          throw new Error("Expected interrupted preview persistence");
        }
        expect(finish.outcome.type).toBe(
          fault === "abort" ? "interrupted" : "failed",
        );
        const storedMessage =
          finish.outcome.type === "interrupted"
            ? cutShortAssistantMessage({
                message: toPersistableChatMessage(finish.responseMessage),
                outcome: finish.outcome,
              })
            : toPersistableChatMessage(finish.responseMessage);
        const persisted = toPersistedChatMessageContentV3({
          data: storedMessage.parts,
        });
        const reloaded = normalizePersistedChatMessageContent(persisted);
        expect(JSON.stringify(persisted)).not.toContain(partial.png);
        expect(JSON.stringify(reloaded)).not.toContain(partial.png);
        expect(JSON.stringify(persisted)).not.toContain('"type":"image"');
        if (cut === "partial-result") {
          expect(JSON.stringify(reloaded)).toContain(
            "screenshot omitted from history",
          );
        }
        expect(
          findUnsettledStoredToolCalls({
            outcome: finish.outcome.type,
            parts: reloaded.parts,
          }),
        ).toEqual([]);
        const next = await persistNativeInterruptTurn(
          projectVisualPreviewStream(
            chat({
              adapter: createTextReplyAdapter("The next turn is clean."),
              messages: [{ role: "user", content: "Continue" }],
              threadId: "preview-thread",
            }),
          ),
        );
        expect(next.finish?.outcome.type).toBe("completed");
        expect(
          next.finish?.responseMessage.parts.some(
            (part) => part.type === "tool-call",
          ),
        ).toBe(false);
      });
    }
  }
});

test("whitespace rejected as an empty completion remains in the raw live processor", async () => {
  const whitespace = " \n\t\u00a0";
  const { emitted, finish, source } = await persistNativeInterruptTurn(
    chat({
      adapter: createTextReplyAdapter(whitespace),
      messages: [{ role: "user", content: "Summarize the NDA" }],
      threadId: "thread-whitespace",
    }),
  );
  expect(
    source.some(
      (chunk) =>
        chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
        chunk.delta === whitespace,
    ),
  ).toBe(true);
  expect(finish?.outcome).toEqual({
    type: "failed",
    error: "empty_completion",
  });
  expect(finish?.responseMessage.parts).toEqual([]);
  expect(emitted.at(-1)?.type).toBe(EventType.RUN_ERROR);

  // RUN_ERROR does not finalize the browser processor as RUN_FINISHED would.
  const live = new StreamProcessor();
  for (const chunk of emitted) {
    live.processChunk(chunk);
  }
  expect(
    live.getMessages().findLast(({ role }) => role === "assistant")?.parts,
  ).toContainEqual({ type: "text", content: whitespace });
});

/**
 * A turn that is cut while the model thinks about a tool result: the run is
 * aborted, the provider request rejects, and the adapter reports that as its
 * terminal `RUN_ERROR` — the shape the OpenRouter text adapter emits from its
 * own catch. `cut` is whichever of the two aborts the caller is exercising.
 */
const createAbortedAfterToolCallAdapter = (cut: () => void): AnyTextAdapter => {
  let iteration = 0;
  return {
    kind: "text",
    name: "aborted-after-tool-call",
    model: "aborted-after-tool-call",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream({ model, runId, threadId }) {
      iteration += 1;
      const timestamp = Date.now();
      const resolvedRunId = runId ?? "run-1";
      const resolvedThreadId = threadId ?? "thread-1";
      if (iteration > 1) {
        // Reading the tool result, the model produces nothing for as long as
        // it thinks; the run is cut first and the provider request rejects
        // with the abort.
        cut();
        yield {
          type: EventType.RUN_ERROR,
          message: "Request aborted",
          code: "aborted",
          model,
          timestamp,
        } satisfies AdapterYieldChunk;
        return;
      }
      yield {
        type: EventType.RUN_STARTED,
        runId: resolvedRunId,
        threadId: resolvedThreadId,
        model,
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "run-code",
        parentMessageId: "provider-message-1",
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: '{"source":"1 + 1"}',
        model,
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: "call-1",
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId: resolvedRunId,
        threadId: resolvedThreadId,
        finishReason: "tool_calls",
        model,
        timestamp,
      } satisfies AdapterYieldChunk;
    },
    structuredOutput: () => {
      throw new Error("Structured output is not part of this fixture");
    },
  };
};

/** Both causes reach the run's signal, so each is cut at its own origin: the
 *  deadline at the source signal `streamChat` is handed, the disconnect at the
 *  controller the response stream cancels. */
type TurnCut = "deadline" | "disconnect";

const persistCutTurn = async (cause: TurnCut) => {
  const deadline = new AbortController();
  const abortController = abortControllerFromSignal(deadline.signal);
  const codeTool = toolDefinition({
    name: "run-code",
    description: "Server-executed code",
    inputSchema: toTanStackToolSchema(v.object({ source: v.string() })),
  }).server(async () => ({ value: 2 }));
  return await persistNativeInterruptTurn(
    chat({
      abortController,
      adapter: createAbortedAfterToolCallAdapter(() => {
        if (cause === "deadline") {
          deadline.abort("provider deadline");
          return;
        }
        abortController.abort("client disconnected");
      }),
      agentLoopStrategy: maxIterations(3),
      messages: [{ role: "user", content: "Add one and one" }],
      threadId: "thread-1",
      tools: [codeTool],
    }),
    { abortSignal: abortController.signal, deadlineSignal: deadline.signal },
  );
};

/** A model call that fails after the provider reported usage, having
 *  written `text` first (none when empty). */
const createFailingAfterUsageAdapter = ({
  text,
  usage,
}: {
  text: string;
  usage: TokenUsage;
}): AnyTextAdapter => ({
  kind: "text",
  name: "failing-after-usage",
  model: "failing-after-usage",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ runId, threadId }) {
    yield {
      type: EventType.RUN_STARTED,
      runId: runId ?? "run-1",
      threadId: threadId ?? "thread-1",
    } satisfies StreamChunk;
    if (text !== "") {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "provider-message-1",
        role: "assistant",
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "provider-message-1",
        delta: text,
      } satisfies StreamChunk;
    }
    yield {
      type: EventType.RUN_ERROR,
      message: "The provider stream ended with an error.",
      code: "incomplete-stream",
      usage,
    } satisfies StreamChunk;
  },
  structuredOutput: () => {
    throw new Error("Structured output is not part of this fixture");
  },
});

describe("a turn whose model call fails after reporting usage", () => {
  for (const text of ["", "The cass"]) {
    test(`stores the usage on the failed turn's message (text: ${JSON.stringify(text)})`, async () => {
      const usage = {
        promptTokens: 24,
        completionTokens: 2,
        totalTokens: 26,
      } satisfies TokenUsage;
      const { finish } = await persistNativeInterruptTurn(
        chat({
          adapter: createFailingAfterUsageAdapter({ text, usage }),
          messages: [{ role: "user", content: "Reply." }],
          threadId: "thread-1",
        }),
      );

      expect(finish?.outcome).toMatchObject({ type: "failed" });
      expect(finish?.responseMessage.metadata).toMatchObject({
        usage: chatMessageUsageFromTokenUsage(usage),
      });
    });
  }
});

describe("a turn cut while the model was thinking", () => {
  test("settles as interrupted, not as a completion with no answer", async () => {
    const { finish, source } = await persistCutTurn("disconnect");

    // The fault this compensates for: the agent loop tests its cancellation
    // before it reads each adapter chunk, so the terminal RUN_ERROR is
    // dropped and the turn drains exactly like a finished one. If a future
    // SDK forwards it, this expectation fails and the branch below can go.
    expect(source.map((chunk) => chunk.type)).not.toContain(
      EventType.RUN_ERROR,
    );
    expect(finish?.outcome).toEqual({
      type: "interrupted",
      reason: "client-disconnected",
    });
    // The tool call the model completed before the cut is still the turn's.
    expect(finish?.responseMessage.parts.map((part) => part.type)).toContain(
      "tool-call",
    );
  });

  test("names the metered provider deadline as a timeout", async () => {
    const { finish } = await persistCutTurn("deadline");

    expect(finish?.outcome).toEqual({
      type: "interrupted",
      reason: "timeout",
    });
  });
});

type AdmissionExit = "drain" | "throw" | "teardown" | "adapter-error";
type AdmissionCheckpoint =
  | "approval"
  | "client-tool"
  | "ask-user"
  | "incomplete";

const persistAdmissionLoss = async ({
  exit,
  checkpoint,
  controlReason,
}: {
  exit: AdmissionExit;
  checkpoint: AdmissionCheckpoint;
  controlReason?: string;
}) => {
  const toolNames = {
    approval: "mcp__external__delete",
    "ask-user": "ask-user",
    "client-tool": "create-document",
    incomplete: "create-document",
  } as const satisfies Record<AdmissionCheckpoint, string>;
  const toolName = toolNames[checkpoint];
  const tool =
    checkpoint === "approval"
      ? toolDefinition({
          name: "mcp__external__delete",
          description: "Fixture interaction",
          inputSchema: draftToolInputSchema,
          needsApproval: true,
        }).server(async () => "deleted")
      : toolDefinition({
          name: toolName,
          description: "Fixture interaction",
          inputSchema: draftToolInputSchema,
        });
  const native = await collectChunks(
    chat({
      adapter: createSingleToolCallAdapter({
        arguments: '{"name":"NDA","source":"@title NDA"}',
        toolName,
      }),
      agentLoopStrategy: maxIterations(3),
      messages: [{ role: "user", content: "Draft a document" }],
      threadId: "thread-1",
      tools: [tool],
    }),
  );
  expect(native.some((chunk) => chunk.type === EventType.TOOL_CALL_END)).toBe(
    true,
  );
  expect(native.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(
    true,
  );
  const fixture =
    checkpoint === "incomplete"
      ? native.filter((chunk) => chunk.type !== EventType.TOOL_CALL_END)
      : native;
  const admission = new AbortController();
  const control = new AbortController();
  const deadline = new AbortController();
  const source = async function* (): AsyncIterable<StreamChunk> {
    yield* fixture;
    admission.abort(
      new ActionAdmissionError({
        message: "Admission lease lost",
        reason: "unavailable",
      }),
    );
    if (controlReason !== undefined) {
      control.abort(controlReason);
    }
    if (exit === "throw") {
      throw new HandlerError({ status: 503, message: "Provider aborted" });
    }
    if (exit === "adapter-error") {
      yield {
        type: EventType.RUN_ERROR,
        code: "provider_unavailable",
        message: "Provider aborted",
      };
    }
    if (exit === "teardown") {
      // A forwarded snapshot lets the consumer close while a terminal finish is still buffered.
      yield buildEngineSnapshot([]);
      throw new HandlerError({
        status: 500,
        message: "Consumer failed to tear down",
      });
    }
  };
  return await persistNativeInterruptTurn(source(), {
    abortSignal: AbortSignal.any([control.signal, admission.signal]),
    deadlineSignal: deadline.signal,
    runSignal: control.signal,
    ...(exit === "teardown"
      ? { teardownAfterSourceChunks: fixture.length + 1 }
      : {}),
  });
};

describe("admission loss before message production identifies the persisted assistant", () => {
  for (const exit of ["drain", "throw", "adapter-error"] as const) {
    test(`${exit} announces one mapped assistant before its refusal`, async () => {
      const admission = new AbortController();
      const source = async function* (): AsyncIterable<StreamChunk> {
        admission.abort(
          new ActionAdmissionError({
            reason: "unavailable",
            message: "Admission lost",
          }),
        );
        if (exit === "throw") {
          throw new HandlerError({ status: 503, message: "Provider aborted" });
        }
        if (exit === "adapter-error") {
          yield {
            type: EventType.RUN_ERROR,
            code: "provider_unavailable",
            message: "Provider aborted",
          };
        }
      };
      const { emitted, finish } = await persistNativeInterruptTurn(source(), {
        abortSignal: admission.signal,
        deadlineSignal: new AbortController().signal,
      });
      expect(
        emitted.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_START),
      ).toEqual([
        expect.objectContaining({
          messageId: finish?.responseMessage.id,
          role: "assistant",
        }),
      ]);
      const client = new StreamProcessor();
      for (const chunk of emitted) {
        client.processChunk(chunk);
      }
      if (finish === null) {
        panic("Admission loss did not settle");
      }
      const reloaded = chatMessageFromPersisted({
        id: finish.responseMessage.id,
        role: finish.responseMessage.role,
        content: structuredClone(
          chatMessageContentFromMessage(finish.responseMessage),
        ),
      });
      expect(reloaded.metadata?.turnOutcome).toEqual(finish.outcome);
      expect(
        new Set([...client.getMessages(), reloaded].map(({ id }) => id)).size,
      ).toBe(1);
      expect(client.getMessages()).toHaveLength(1);
      expect(client.getMessages().at(0)?.id).toBe(finish.responseMessage.id);
      expect(emitted.at(0)?.type).toBe(EventType.TEXT_MESSAGE_START);
      expect(emitted.at(1)).toEqual(
        expect.objectContaining({
          type: EventType.RUN_ERROR,
          code: ACTION_ADMISSION_CODES.admissionUnavailable,
        }),
      );
      expect(finish.responseMessage.metadata.turnOutcome).toEqual(
        finish.outcome,
      );
    });
  }
});

describe("admission loss preserves complete interaction checkpoints", () => {
  for (const exit of ["drain", "throw", "teardown", "adapter-error"] as const) {
    for (const checkpoint of [
      "approval",
      "client-tool",
      "ask-user",
      "incomplete",
    ] as const) {
      test(`${exit} keeps ${checkpoint} infrastructure loss distinct from a user stop`, async () => {
        const { finish, emitted } = await persistAdmissionLoss({
          exit,
          checkpoint,
        });
        expect(finish?.outcome).toEqual(
          checkpoint === "incomplete"
            ? {
                type: "failed",
                error: "provider_unavailable",
                refusal: {
                  code: ACTION_ADMISSION_CODES.admissionUnavailable,
                  ...ACTION_ADMISSION_REFUSALS[
                    ACTION_ADMISSION_CODES.admissionUnavailable
                  ],
                },
              }
            : {
                type: "awaiting-user",
                interaction: { type: checkpoint, toolCallId: "call-1" },
              },
        );
        expect(
          emitted.some((chunk) => chunk.type === EventType.RUN_ERROR),
        ).toBe(checkpoint === "incomplete" && exit !== "teardown");
        expect(
          finish?.responseMessage.parts.some(
            (part) => part.type === "tool-call",
          ),
        ).toBe(true);
      });
    }
    for (const controlReason of [
      RUN_CANCEL_REASON,
      CHAT_TURN_OWNER_LOST_REASON,
    ]) {
      test(`${exit} preserves ${controlReason} precedence after admission loss`, async () => {
        const { finish } = await persistAdmissionLoss({
          exit,
          checkpoint: "approval",
          controlReason,
        });
        expect(finish?.outcome).toEqual(
          controlReason === RUN_CANCEL_REASON
            ? { type: "cancelled", reason: "user-stop" }
            : { type: "interrupted", reason: "owner-lost" },
        );
      });
    }
  }
});

describe("late admission loss retains a completed and charged response", () => {
  test("an empty successful finish retains its empty-provider outcome after one charge", async () => {
    const admission = new AbortController();
    let charges = 0;
    const source = async function* (): AsyncIterable<StreamChunk> {
      yield {
        type: EventType.RUN_STARTED,
        runId: "empty_run",
        threadId: "thread-1",
      };
      yield {
        type: EventType.RUN_FINISHED,
        runId: "empty_run",
        threadId: "thread-1",
        finishReason: "stop",
        outcome: { type: "success" },
      };
      charges += 1;
      admission.abort(
        new ActionAdmissionError({
          reason: "unavailable",
          message: "Lease lost after empty completion",
        }),
      );
    };
    const { finish, emitted } = await persistNativeInterruptTurn(source(), {
      abortSignal: admission.signal,
      deadlineSignal: new AbortController().signal,
    });
    expect(finish?.outcome).toEqual({
      type: "failed",
      error: "empty_completion",
    });
    expect(charges).toBe(1);
    expect(
      emitted.filter((chunk) => chunk.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
  });
  for (const exit of ["drain", "throw", "teardown", "adapter-error"] as const) {
    for (const completed of [true, false]) {
      test(`${exit} distinguishes ${completed ? "completed" : "interrupted"} text after upstream settlement`, async () => {
        const native = await collectChunks(
          chat({
            adapter: createTextReplyAdapter("Completed answer"),
            messages: [{ role: "user", content: "Reply" }],
            threadId: "thread-1",
          }),
        );
        expect(
          native.some((chunk) => chunk.type === EventType.RUN_FINISHED),
        ).toBe(true);
        const fixture = completed
          ? native
          : native.filter((chunk) => chunk.type !== EventType.RUN_FINISHED);
        const admission = new AbortController();
        let charges = 0;
        const source = async function* (): AsyncIterable<StreamChunk> {
          yield* fixture;
          if (completed) {
            charges += 1;
          }
          admission.abort(
            new ActionAdmissionError({
              reason: "unavailable",
              message: "Lease lost during upstream cleanup",
            }),
          );
          if (exit === "throw") {
            throw new HandlerError({
              status: 503,
              message: "Upstream cleanup aborted",
            });
          }
          if (exit === "adapter-error") {
            yield {
              type: EventType.RUN_ERROR,
              code: "provider_unavailable",
              message: "Cleanup aborted",
            };
          }
          if (exit === "teardown") {
            yield buildEngineSnapshot([]);
          }
        };
        const { emitted, finish } = await persistNativeInterruptTurn(source(), {
          abortSignal: admission.signal,
          deadlineSignal: new AbortController().signal,
          ...(exit === "teardown"
            ? { teardownAfterSourceChunks: fixture.length + 1 }
            : {}),
        });
        expect(finish?.outcome).toEqual(
          completed
            ? { type: "completed" }
            : {
                type: "failed",
                error: "provider_unavailable",
                refusal: {
                  code: ACTION_ADMISSION_CODES.admissionUnavailable,
                  ...ACTION_ADMISSION_REFUSALS[
                    ACTION_ADMISSION_CODES.admissionUnavailable
                  ],
                },
              },
        );
        expect(finish?.responseMessage.parts).toContainEqual({
          type: "text",
          content: "Completed answer",
        });
        expect(charges).toBe(completed ? 1 : 0);
        expect(
          emitted.some((chunk) => chunk.type === EventType.RUN_ERROR),
        ).toBe(!completed && exit !== "teardown");
        if (completed && exit !== "teardown") {
          expect(
            emitted.filter((chunk) => chunk.type === EventType.RUN_FINISHED),
          ).toHaveLength(1);
        }
      });
    }
  }
});

describe("admission lost before continuation production retains the original checkpoint", () => {
  for (const exit of ["drain", "throw", "teardown"] as const) {
    test(`${exit} preserves the original pending snapshot and message identity`, async () => {
      const checkpoint = toPersistableChatMessage({
        id: toSafeId<"chatMessage">("original_pending_message"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "original_call",
            name: "web_search",
            arguments: "{}",
            state: "approval-requested",
            approval: { id: "original_approval", needsApproval: true },
          },
        ],
      });
      const admission = new AbortController();
      admission.abort(
        new ActionAdmissionError({
          reason: "unavailable",
          message: "Lease lost before dispatch",
        }),
      );
      const source = async function* (): AsyncIterable<StreamChunk> {
        if (exit === "throw") {
          throw new HandlerError({
            status: 503,
            message: "Already aborted provider",
          });
        }
        if (exit === "teardown") {
          yield buildEngineSnapshot([]);
        }
      };
      const { finish } = await persistNativeInterruptTurn(source(), {
        abortSignal: admission.signal,
        deadlineSignal: new AbortController().signal,
        getRestorableCheckpoint: () => checkpoint,
        ...(exit === "teardown" ? { teardownAfterSourceChunks: 1 } : {}),
      });
      expect(finish?.outcome).toEqual({
        type: "awaiting-user",
        interaction: { type: "approval", toolCallId: "original_call" },
      });
      expect(finish?.responseMessage.id).toBe(checkpoint.id);
      expect(finish?.responseMessage.parts).toEqual(checkpoint.parts);
    });
  }
});

describe("native interrupt boundary persistence", () => {
  test("persists a client-tool turn the loop pauses for, and awaits the client", async () => {
    const draftTool = toolDefinition({
      name: "create-document",
      description: "Client-executed draft",
      inputSchema: draftToolInputSchema,
    });
    const { emitted, finish, source } = await persistNativeInterruptTurn(
      chat({
        adapter: createSingleToolCallAdapter({
          arguments: '{"name":"NDA","source":"@title NDA"}',
          toolName: "create-document",
        }),
        agentLoopStrategy: maxIterations(3),
        messages: [{ role: "user", content: "Draft an NDA" }],
        threadId: "thread-1",
        tools: [draftTool],
      }),
    );

    // The fixture must express the fault: the loop emits a snapshot before the
    // interrupted run's finish. Without this the assertion below is vacuous.
    const types = source.map((chunk) => chunk.type);
    expect(types.indexOf(EventType.MESSAGES_SNAPSHOT)).toBeGreaterThan(-1);
    expect(types.indexOf(EventType.MESSAGES_SNAPSHOT)).toBeLessThan(
      types.lastIndexOf(EventType.RUN_FINISHED),
    );

    expect(emitted.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(finish?.outcome).toEqual({
      type: "awaiting-user",
      interaction: { type: "client-tool", toolCallId: "call-1" },
    });
    expect(finish?.responseMessage.parts).toEqual([
      {
        arguments: '{"name":"NDA","source":"@title NDA"}',
        id: "call-1",
        input: { name: "NDA", source: "@title NDA" },
        name: "create-document",
        state: "input-complete",
        type: "tool-call",
      },
    ]);
  });

  test("persists an approval-gated turn the loop pauses for, and awaits the approval", async () => {
    const approvalTool = toolDefinition({
      name: "mcp__external__delete",
      description: "Server tool behind an approval",
      inputSchema: draftToolInputSchema,
      needsApproval: true,
    }).server(async () => "deleted");
    const { emitted, finish, source } = await persistNativeInterruptTurn(
      chat({
        adapter: createSingleToolCallAdapter({
          arguments: '{"name":"NDA","source":"@title NDA"}',
          toolName: "mcp__external__delete",
        }),
        agentLoopStrategy: maxIterations(3),
        messages: [{ role: "user", content: "Delete the NDA" }],
        threadId: "thread-1",
        tools: [approvalTool],
      }),
    );

    expect(source.map((chunk) => chunk.type)).toContain(
      EventType.MESSAGES_SNAPSHOT,
    );
    expect(emitted.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(finish?.outcome).toMatchObject({
      type: "awaiting-user",
      interaction: { type: "approval", toolCallId: "call-1" },
    });
    expect(finish?.responseMessage.parts).toMatchObject([
      {
        id: "call-1",
        name: "mcp__external__delete",
        state: "approval-requested",
        type: "tool-call",
      },
    ]);
  });

  for (const compacted of [false, true]) {
    test(`keeps model summaries off the live approval page (compacted: ${String(compacted)})`, async () => {
      const summary = createCompactionSummaryMessage({
        summarizedMessageCount: 4,
        summary: "Earlier conversation context",
      });
      // Identical text in a real user message must remain visible.
      const user = {
        id: "user-1",
        role: "user",
        parts: summary.parts,
      } satisfies ChatMessage;
      const initialMessages = compacted ? [summary, user] : [user];
      const approvalTool = toolDefinition({
        name: "mcp__external__delete",
        description: "Server tool behind an approval",
        inputSchema: draftToolInputSchema,
        needsApproval: true,
      }).server(async () => "deleted");
      const { emitted, finish, source } = await persistNativeInterruptTurn(
        chat({
          adapter: createSingleToolCallAdapter({
            arguments: '{"name":"NDA","source":"@title NDA"}',
            toolName: "mcp__external__delete",
          }),
          agentLoopStrategy: maxIterations(3),
          messages: initialMessages,
          threadId: "thread-1",
          tools: [approvalTool],
        }),
      );
      const engineSnapshot = source.find(
        (chunk) => chunk.type === EventType.MESSAGES_SNAPSHOT,
      );
      if (engineSnapshot?.type !== EventType.MESSAGES_SNAPSHOT) {
        throw new Error("Expected the real engine's approval snapshot");
      }
      expect(
        engineSnapshot.messages.some(
          ({ id }) => id === COMPACTION_SUMMARY_MESSAGE_ID,
        ),
      ).toBe(compacted);
      expect(finish?.outcome).toMatchObject({
        type: "awaiting-user",
        interaction: { type: "approval", toolCallId: "call-1" },
      });
      const visible = await collectChunks(
        transformClientVisibleStream({
          source: streamChunks(emitted),
          storedHistory: NOTHING_REWRITTEN,
        }),
      );
      const { processor } = createStreamMessageCapture({
        initialMessages: [user],
        capture: (message) => message,
      });
      for (const chunk of visible) {
        processor.processChunk(chunk);
      }
      if (finish === null) {
        throw new Error("Expected the real engine to finish the turn");
      }
      expect(
        processor
          .getMessages()
          .map(({ id, role, parts }) => ({ id, role, parts })),
      ).toEqual([
        user,
        {
          id: finish.responseMessage.id,
          role: "assistant",
          parts: finish.responseMessage.parts,
        },
      ]);
      // Presentation must not mutate the history the model and persistence read.
      expect(
        engineSnapshot.messages.some(
          ({ id }) => id === COMPACTION_SUMMARY_MESSAGE_ID,
        ),
      ).toBe(compacted);
    });
  }

  // The same pause, driven by the real `suggest_changes` apply tool rather
  // than a fixture: it carries folio's raw JSON Schema wrapped as a Standard
  // Schema, so its `inputSchema` has to survive `normalizeApprovalSchema`
  // before the loop can request approval at all. The DB is untouched before
  // approval, so the tool only needs props that type-check.
  test("pauses for approval on the automatic-apply suggest_changes tool", async () => {
    const expectedCurrentVersionId = toSafeId<"entityVersion">(
      "66666666-6666-4666-8666-666666666666",
    );
    const { safeDb } = createScopedDbMock({});
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId: toSafeId<"organization">(
        "22222222-2222-4222-8222-222222222222",
      ),
      userId: toSafeId<"user">("33333333-3333-4333-8333-333333333333"),
      access: memberDocumentWriteAccess({
        type: "new_version",
        workspaceId: toSafeId<"workspace">(
          "44444444-4444-4444-8444-444444444444",
        ),
        entityId: toSafeId<"entity">("55555555-5555-4555-8555-555555555555"),
      }),
      fileFieldId: toSafeId<"field">("77777777-7777-4777-8777-777777777777"),
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId,
    });
    const suggestChanges = applyChatToolPolicy(
      tools[SUGGEST_CHANGES_TOOL_NAME],
      CHAT_TOOL_POLICY_KIND.mutation,
    );
    // The fixture must express the fault: without an approval gate the loop
    // would execute the tool instead of pausing, and the outcome assertion
    // below would never reach the interrupt boundary.
    expect(suggestChanges).toMatchObject({ needsApproval: true });

    const { emitted, finish } = await persistNativeInterruptTurn(
      chat({
        adapter: createSingleToolCallAdapter({
          arguments: JSON.stringify({
            documentVersion: expectedCurrentVersionId,
            operations: [
              {
                type: "replaceInBlock",
                blockId: "block-1",
                find: "quick",
                replace: "slow",
              },
            ],
          }),
          toolName: SUGGEST_CHANGES_TOOL_NAME,
        }),
        agentLoopStrategy: maxIterations(3),
        messages: [{ role: "user", content: "Replace quick with slow" }],
        threadId: "thread-1",
        tools: [suggestChanges],
      }),
    );

    expect(emitted.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(finish?.outcome).toMatchObject({
      type: "awaiting-user",
      interaction: { type: "approval", toolCallId: "call-1" },
    });
    expect(finish?.responseMessage.parts).toMatchObject([
      {
        id: "call-1",
        name: SUGGEST_CHANGES_TOOL_NAME,
        state: "approval-requested",
        type: "tool-call",
      },
    ]);
  });

  // OpenAI strict mode makes every optional field required and nullable, so
  // the model omits `context` by sending `null`. The adapter streams that
  // wire string and hands the un-widened value on `TOOL_CALL_END`; the
  // persisted part must carry that value, or the persistence validator fails
  // the turn in `onFinish` before the approval card renders. The
  // spawn_subagents schema has several nullable optional fields; delegation
  // itself runs without approval, so the test pauses it under the mutation
  // policy to keep a paused call with nulled fields covered.
  test("persists a paused call whose model nulled its optional fields", async () => {
    const { safeDb } = createScopedDbMock({});
    const tools = createSpawnSubagentsTool({
      buildSubagentToolset: () => ({}),
      // The tool pauses for approval here and never runs a subagent.
      modelAdmission: undefined,
      organizationId: toSafeId<"organization">(
        "22222222-2222-4222-8222-222222222222",
      ),
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      safeDb,
      userId: toSafeId<"user">("33333333-3333-4333-8333-333333333333"),
      workspaceId: null,
      threadId: toSafeId<"chatThread">("44444444-4444-4444-8444-444444444444"),
      delegationDepth: 0,
      thirdPartyBoundary: { type: "raw" },
    });
    const spawnSubagents = applyChatToolPolicy(
      tools[SPAWN_SUBAGENTS_TOOL_NAME],
      CHAT_TOOL_POLICY_KIND.mutation,
    );
    expect(spawnSubagents).toMatchObject({ needsApproval: true });

    const { emitted, finish } = await persistNativeInterruptTurn(
      chat({
        adapter: createSingleToolCallAdapter({
          arguments: JSON.stringify({
            subagents: [
              {
                title: "List matters",
                task: "list matters",
                context: null,
                expectedOutput: null,
                model: null,
              },
            ],
          }),
          input: {
            subagents: [{ title: "List matters", task: "list matters" }],
          },
          toolName: SPAWN_SUBAGENTS_TOOL_NAME,
        }),
        agentLoopStrategy: maxIterations(3),
        messages: [
          { role: "user", content: "Use subagents to list my matters." },
        ],
        threadId: "thread-1",
        tools: [spawnSubagents],
      }),
    );

    expect(emitted.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(finish?.outcome).toMatchObject({
      type: "awaiting-user",
      interaction: { type: "approval", toolCallId: "call-1" },
    });
    if (!finish) {
      throw new Error("Expected the turn to finish");
    }
    expect(finish.responseMessage.parts).toMatchObject([
      {
        arguments: JSON.stringify({
          subagents: [{ title: "List matters", task: "list matters" }],
        }),
        id: "call-1",
        input: { subagents: [{ title: "List matters", task: "list matters" }] },
        name: SPAWN_SUBAGENTS_TOOL_NAME,
        state: "approval-requested",
        type: "tool-call",
      },
    ]);
    const validated = validateToolCallParts({
      message: finish.responseMessage,
      tools: { [SPAWN_SUBAGENTS_TOOL_NAME]: spawnSubagents },
    });
    expect(Result.isOk(validated)).toBe(true);
  });

  test("keeps a server tool's iteration in the same persisted turn as the client tool it precedes", async () => {
    const lookupTool = toolDefinition({
      name: "mcp__external__lookup",
      description: "Server tool that runs before the draft",
      inputSchema: draftToolInputSchema,
    }).server(async () => ({ templates: [] }));
    const draftTool = toolDefinition({
      name: "create-document",
      description: "Client-executed draft",
      inputSchema: draftToolInputSchema,
    });
    const { emitted, finish } = await persistNativeInterruptTurn(
      chat({
        adapter: createToolCallSequenceAdapter([
          {
            arguments: '{"name":"NDA","source":"@title NDA"}',
            toolName: "mcp__external__lookup",
          },
          {
            arguments: '{"name":"NDA","source":"@title NDA"}',
            toolName: "create-document",
          },
        ]),
        agentLoopStrategy: maxIterations(3),
        messages: [{ role: "user", content: "Draft an NDA" }],
        threadId: "thread-1",
        tools: [lookupTool, draftTool],
      }),
    );

    expect(emitted.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(finish?.outcome).toEqual({
      type: "awaiting-user",
      interaction: { type: "client-tool", toolCallId: "call-2" },
    });
    expect(finish?.responseMessage.parts).toMatchObject([
      { id: "call-1", name: "mcp__external__lookup", state: "complete" },
      { id: "call-2", name: "create-document", state: "input-complete" },
      { toolCallId: "call-1", type: "tool-result" },
    ]);
    const client = createStreamMessageCapture({
      initialMessages: [],
      capture: toChatMessage,
    });
    for (const chunk of emitted) {
      client.processor.processChunk(chunk);
    }
    expect(client.message()?.parts).toEqual(finish?.responseMessage.parts);
    // The client-facing snapshot presents the same single assistant message,
    // under the persisted id, so the continuation targets the persisted turn.
    const snapshot = emitted.find(
      (chunk) => chunk.type === EventType.MESSAGES_SNAPSHOT,
    );
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) {
      throw new Error("Expected the loop to emit a snapshot");
    }
    const assistantSnapshotMessages = snapshot.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantSnapshotMessages).toHaveLength(1);
    expect(assistantSnapshotMessages.at(0)?.id).toBe(
      finish?.responseMessage.id,
    );
  });
});

describe("native continuation persistence", () => {
  const owningMessageId = toSafeId<"chatMessage">(
    "11111111-1111-4111-8111-111111111111",
  );
  const userMessage: ChatMessage = {
    id: "user-1",
    role: "user",
    parts: [{ content: "Create a draft playbook named Repro", type: "text" }],
  };
  const savePlaybookTool = toolDefinition({
    name: "save_playbook",
    description: "Server tool behind an approval",
    inputSchema: draftToolInputSchema,
    needsApproval: true,
  }).server(async () => ({ playbookId: "playbook-1" }));

  /** The owning assistant message as the client replays it once the user approves. */
  const approvedOwningMessage = ({
    id,
    toolCallId,
  }: {
    id: string;
    toolCallId: string;
  }): ChatMessage => ({
    id,
    role: "assistant",
    parts: [
      {
        approval: {
          approved: true,
          id: `approval_${toolCallId}`,
          needsApproval: true,
        },
        arguments: '{"name":"Repro","source":"@title Repro"}',
        id: toolCallId,
        input: { name: "Repro", source: "@title Repro" },
        name: "save_playbook",
        state: "approval-responded",
        type: "tool-call",
      },
    ],
  });

  /** Resume an approval the way `streamChat` wires a continuation. */
  const continueTurn = async ({
    adapter,
    messages,
    owningAssistantMessageId,
    parentRunId,
    runId,
    toolCallId,
  }: {
    adapter: AnyTextAdapter;
    messages: ChatMessage[];
    owningAssistantMessageId: string;
    parentRunId: string;
    runId: string;
    toolCallId: string;
  }) => {
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      initialMessages: messages,
      events: {
        onStreamEnd: (message) => {
          responseMessage = toChatMessage(message);
        },
      },
    });
    const terminal: { finish: ProcessedStreamFinishEvent | null } = {
      finish: null,
    };
    const emitted = await collectChunks(
      processServerChatStream({
        ...uncutTurnSignals(),
        getResponseMessage: () => responseMessage,
        initialMessages: messages,
        mapMessageId: createTurnMessageIdMapper(
          toSafeId<"chatMessage">(owningAssistantMessageId),
        ),
        onFinish: (event) => {
          terminal.finish = event;
        },
        processor,
        source: chat({
          adapter,
          agentLoopStrategy: maxIterations(3),
          messages,
          parentRunId,
          resume: [
            {
              interruptId: `approval_${toolCallId}`,
              payload: { approved: true },
              status: "resolved",
            },
          ],
          runId,
          threadId: "thread-1",
          tools: [savePlaybookTool],
        }),
      }),
    );
    return { emitted, finish: terminal.finish };
  };

  const firstContinuation = async () =>
    await continueTurn({
      adapter: createTextReplyAdapter("Saved the draft."),
      messages: [
        userMessage,
        approvedOwningMessage({ id: owningMessageId, toolCallId: "call-1" }),
      ],
      owningAssistantMessageId: owningMessageId,
      parentRunId: "run-1",
      runId: "run-2",
      toolCallId: "call-1",
    });

  test("persists the approved tool's result and the follow-up on the owning assistant message", async () => {
    const messages = [
      userMessage,
      approvedOwningMessage({ id: owningMessageId, toolCallId: "call-1" }),
    ];
    const { emitted, finish } = await firstContinuation();

    expect(emitted.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(finish?.outcome).toEqual({ type: "completed" });
    expect(finish?.responseMessage.id).toBe(owningMessageId);
    expect(finish?.responseMessage.parts).toMatchObject([
      {
        id: "call-1",
        name: "save_playbook",
        output: { playbookId: "playbook-1" },
        state: "complete",
        type: "tool-call",
      },
      { state: "complete", toolCallId: "call-1", type: "tool-result" },
      { content: "Saved the draft.", type: "text" },
    ]);

    // The browser continues the replayed message from the same chunks: one
    // assistant message, carrying the parts the server persisted.
    const clientProcessor = new StreamProcessor({ initialMessages: messages });
    for (const chunk of emitted) {
      clientProcessor.processChunk(chunk);
    }
    clientProcessor.finalizeStream();
    const clientAssistantMessages = clientProcessor
      .getMessages()
      .filter((message) => message.role === "assistant");
    expect(
      clientAssistantMessages.map((message) => toChatMessage(message)?.parts),
    ).toEqual([finish?.responseMessage.parts]);
  });

  test("resumes a later approval in the thread against the persisted continuation", async () => {
    const firstTurn = await firstContinuation();
    const persistedOwningMessage: ChatMessage = {
      id: owningMessageId,
      parts: firstTurn.finish?.responseMessage.parts ?? [],
      role: "assistant",
    };
    const secondOwningMessageId = toSafeId<"chatMessage">(
      "22222222-2222-4222-8222-222222222222",
    );
    const secondUserMessage: ChatMessage = {
      id: "user-2",
      role: "user",
      parts: [{ content: "Save another one", type: "text" }],
    };
    const secondOwningMessage = approvedOwningMessage({
      id: secondOwningMessageId,
      toolCallId: "call-2",
    });
    const resumeSecondApproval = async (firstOwningMessage: ChatMessage) =>
      await continueTurn({
        adapter: createTextReplyAdapter("Saved the second draft."),
        messages: [
          userMessage,
          firstOwningMessage,
          secondUserMessage,
          secondOwningMessage,
        ],
        owningAssistantMessageId: secondOwningMessageId,
        parentRunId: "run-3",
        runId: "run-4",
        toolCallId: "call-2",
      });

    const secondTurn = await resumeSecondApproval(persistedOwningMessage);
    expect(
      secondTurn.emitted.some((chunk) => chunk.type === EventType.RUN_ERROR),
    ).toBe(false);
    expect(secondTurn.finish?.outcome).toEqual({ type: "completed" });
    expect(secondTurn.finish?.responseMessage.id).toBe(secondOwningMessageId);

    // The fixture must express the fault: an approved call persisted without
    // its result is rebuilt by the loop as a pending interrupt, so the batch
    // that resolves only the second approval is rejected.
    const staleTurn = await resumeSecondApproval(
      approvedOwningMessage({ id: owningMessageId, toolCallId: "call-1" }),
    );
    expect(
      staleTurn.emitted.some((chunk) => chunk.type === EventType.RUN_ERROR),
    ).toBe(true);
    expect(staleTurn.finish?.outcome).toMatchObject({ type: "failed" });
  });
  test("continues the whole owning message after an interrupt when it already holds a tool result", async () => {
    const messages: ChatMessage[] = [
      userMessage,
      {
        id: owningMessageId,
        role: "assistant",
        parts: [
          {
            arguments: "{}",
            id: "call-lookup",
            input: {},
            name: "list_templates",
            output: { templates: [] },
            state: "complete",
            type: "tool-call",
          },
          {
            content: '{"templates":[]}',
            state: "complete",
            toolCallId: "call-lookup",
            type: "tool-result",
          },
          ...approvedOwningMessage({
            id: owningMessageId,
            toolCallId: "call-save",
          }).parts,
        ],
      },
    ];
    const { emitted, finish } = await continueTurn({
      adapter: createSingleToolCallAdapter({
        arguments: '{"name":"Again","source":"@title Again"}',
        toolName: "save_playbook",
      }),
      messages,
      owningAssistantMessageId: owningMessageId,
      parentRunId: "run-1",
      runId: "run-2",
      toolCallId: "call-save",
    });

    expect(finish?.responseMessage.id).toBe(owningMessageId);
    const toolCallStates = (parts: ChatMessage["parts"] | undefined) =>
      (parts ?? []).flatMap((part) =>
        part.type === "tool-call" ? [{ id: part.id, state: part.state }] : [],
      );
    const persistedToolCalls = toolCallStates(finish?.responseMessage.parts);
    expect(persistedToolCalls.map(({ id }) => id)).toEqual([
      "call-lookup",
      "call-save",
      "call-1",
    ]);

    const snapshotAssistantIds = emitted.flatMap((chunk) =>
      chunk.type === EventType.MESSAGES_SNAPSHOT
        ? chunk.messages.flatMap((message) =>
            message.role === "assistant" ? [message.id] : [],
          )
        : [],
    );
    expect(snapshotAssistantIds).toEqual([owningMessageId]);

    // The browser keeps continuing one message that carries every call the
    // server persisted, and replays that message on the next answer.
    const clientProcessor = new StreamProcessor({ initialMessages: messages });
    for (const chunk of emitted) {
      clientProcessor.processChunk(chunk);
    }
    clientProcessor.finalizeStream();
    const clientAssistantMessages = clientProcessor
      .getMessages()
      .filter((message) => message.role === "assistant");
    expect(
      clientAssistantMessages.map((message) => ({
        id: message.id,
        toolCalls: toolCallStates(toChatMessage(message)?.parts),
      })),
    ).toEqual([{ id: owningMessageId, toolCalls: persistedToolCalls }]);
    expect(clientProcessor.getMessages().at(-1)?.id).toBe(owningMessageId);
  });
});

describe("outgoing chat stream message ids", () => {
  test("requires an input-complete event before ask-user takes terminal ownership", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const askUserCallSequences = [
      [
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-message",
          toolCallId: "ask-awaiting-input",
          toolCallName: "ask-user",
        },
      ],
      [
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-message",
          toolCallId: "ask-input-complete",
          toolCallName: "ask-user",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta: '{"question":"Which jurisdiction applies?"}',
          toolCallId: "ask-input-complete",
        },
        {
          type: EventType.TOOL_CALL_END,
          input: { question: "Which jurisdiction applies?" },
          toolCallId: "ask-input-complete",
        },
      ],
      [
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-message",
          toolCallId: "ask-input-streaming",
          toolCallName: "ask-user",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta: '{"question":"Which',
          toolCallId: "ask-input-streaming",
        },
      ],
    ] as const satisfies readonly (readonly StreamChunk[])[];

    const terminalOutcomes = await Promise.all(
      askUserCallSequences.map(async (callChunks) => {
        let responseMessage: ChatMessage | null = null;
        let resolveTerminalOutcome: (outcome: string) => void;
        const terminalOutcome = new Promise<string>((resolve) => {
          resolveTerminalOutcome = resolve;
        });
        const processor = new StreamProcessor({
          events: {
            onStreamEnd: (message) => {
              responseMessage = toChatMessage(message);
            },
          },
        });
        const stream = processServerChatStream({
          abortSignal: new AbortController().signal,
          deadlineSignal: new AbortController().signal,
          getResponseMessage: () => responseMessage,
          initialMessages: [],
          mapMessageId: createChatMessageIdMapper(() => messageId),
          onFinish: ({ outcome }) => {
            resolveTerminalOutcome(outcome.type);
          },
          processor,
          source: streamChunks([
            {
              type: EventType.RUN_STARTED,
              runId: "run-1",
              threadId: "thread-1",
            },
            ...callChunks,
            {
              type: EventType.RUN_FINISHED,
              finishReason: "tool_calls",
              // The engine hands the call out as an interrupt either way; only
              // its input decides whether the turn may wait on it.
              outcome: {
                type: "interrupt",
                interrupts: [
                  {
                    id: `interrupt-${callChunks[0].toolCallId}`,
                    reason: "tool_call",
                    toolCallId: callChunks[0].toolCallId,
                  },
                ],
              },
              runId: "run-1",
              threadId: "thread-1",
            },
          ]),
        });

        await collectChunks(stream);
        return await terminalOutcome;
      }),
    );

    expect(terminalOutcomes).toEqual(["failed", "awaiting-user", "failed"]);
  });

  test("normalizes provider assistant message ids to one stable stella UUID", async () => {
    const firstId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const ids = [firstId];
    let index = 0;
    const mapMessageId = createChatMessageIdMapper(() => {
      const nextId = ids.at(index);
      if (nextId === undefined) {
        throw new Error("Unexpected message id request");
      }
      index += 1;
      return nextId;
    });

    expect(
      await collectChunks(
        remapOutgoingMessageIds({
          mapMessageId,
          source: streamChunks([
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "openrouter-responses-a",
              role: "assistant",
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              delta: "Ahoj",
              messageId: "openrouter-responses-a",
            },
            {
              type: EventType.CUSTOM,
              name: "structured-output.start",
              value: { messageId: "openrouter-responses-a" },
            },
            {
              type: EventType.TOOL_CALL_START,
              parentMessageId: "openrouter-responses-b",
              toolCallId: "tool-1",
              toolCallName: "ask-user",
            },
            {
              type: EventType.TOOL_CALL_RESULT,
              content: "{}",
              messageId: "openrouter-responses-b",
              toolCallId: "tool-1",
            },
            {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "openrouter-responses-a",
            },
          ]),
        }),
      ),
    ).toEqual([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: firstId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Ahoj",
        messageId: firstId,
      },
      {
        type: EventType.CUSTOM,
        name: "structured-output.start",
        value: { messageId: firstId },
      },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: firstId,
        toolCallId: "tool-1",
        toolCallName: "ask-user",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        content: "{}",
        messageId: firstId,
        toolCallId: "tool-1",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: firstId,
      },
    ]);
    expect(index).toBe(1);
  });

  test("folds the run's assistant snapshot messages into the one persisted assistant message", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const existingMessageIds = new Set(["user-1", "assistant-previous"]);

    const chunks = await collectChunks(
      remapOutgoingMessageIds({
        existingMessageIds,
        mapMessageId: createChatMessageIdMapper(() => messageId),
        source: streamChunks([
          buildWireSnapshot([
            {
              id: "user-1",
              role: "user",
              content: "Please continue",
            },
            {
              id: "assistant-previous",
              role: "assistant",
              content: "Earlier answer",
            },
            {
              id: "provider-message-1",
              role: "assistant",
              content: "Checking the request",
              toolCalls: [
                {
                  id: "tool-lookup",
                  type: "function",
                  function: { name: "list_templates", arguments: "{}" },
                },
              ],
            },
            {
              id: "tool-lookup-result",
              role: "tool",
              toolCallId: "tool-lookup",
              content: '{"templates":[]}',
            },
            {
              id: "provider-message-2",
              role: "assistant",
              content: "Waiting for approval",
              toolCalls: [
                {
                  id: "tool-draft",
                  type: "function",
                  function: {
                    name: "create-document",
                    arguments: '{"name":"NDA","source":"@title NDA"}',
                  },
                },
              ],
            },
          ]),
          {
            type: EventType.TOOL_CALL_RESULT,
            content: '{"approved":true}',
            messageId: "assistant-previous",
            toolCallId: "tool-existing",
          },
          {
            type: EventType.TOOL_CALL_START,
            parentMessageId: "assistant-previous",
            toolCallId: "tool-follow-up",
            toolCallName: "web_search",
          },
          {
            type: EventType.CUSTOM,
            name: "application-event",
            value: { messageId: "assistant-previous" },
          },
        ]),
      }),
    );
    expect(chunks).toEqual([
      buildWireSnapshot([
        {
          id: "user-1",
          role: "user",
          content: "Please continue",
        },
        {
          id: "assistant-previous",
          role: "assistant",
          content: "Earlier answer",
        },
        // One assistant message per persisted turn: both iterations' text and
        // tool calls, under the turn's stable id, tool messages anchoring by
        // toolCallId behind it.
        {
          id: messageId,
          role: "assistant",
          content: "Checking the request\n\nWaiting for approval",
          toolCalls: [
            {
              id: "tool-lookup",
              type: "function",
              function: { name: "list_templates", arguments: "{}" },
            },
            {
              id: "tool-draft",
              type: "function",
              function: {
                name: "create-document",
                arguments: '{"name":"NDA","source":"@title NDA"}',
              },
            },
          ],
        },
        {
          id: "tool-lookup-result",
          role: "tool",
          toolCallId: "tool-lookup",
          content: '{"templates":[]}',
        },
      ]),
      {
        type: EventType.TOOL_CALL_RESULT,
        content: '{"approved":true}',
        messageId: "assistant-previous",
        toolCallId: "tool-existing",
      },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-previous",
        toolCallId: "tool-follow-up",
        toolCallName: "web_search",
      },
      {
        type: EventType.CUSTOM,
        name: "application-event",
        value: { messageId: "assistant-previous" },
      },
    ]);
  });

  test("folds a continuation's snapshot messages into the owning assistant message", async () => {
    const owningMessageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const savedCall = {
      id: "call-1",
      type: "function",
      function: {
        name: "save_playbook",
        arguments: '{"name":"Repro","source":"@title Repro"}',
      },
    } as const;
    const nextCall = {
      id: "call-2",
      type: "function",
      function: {
        name: "save_playbook",
        arguments: '{"name":"Again","source":"@title Again"}',
      },
    } as const;

    const chunks = await collectChunks(
      remapOutgoingMessageIds({
        existingMessageIds: new Set(["user-1", owningMessageId]),
        mapMessageId: createTurnMessageIdMapper(owningMessageId),
        source: streamChunks([
          buildWireSnapshot([
            { id: "user-1", role: "user", content: "Save the draft" },
            {
              id: owningMessageId,
              role: "assistant",
              content: "Saving the draft",
              toolCalls: [savedCall],
            },
            {
              id: "call-1-result",
              role: "tool",
              toolCallId: "call-1",
              content: '{"playbookId":"playbook-1"}',
            },
            {
              id: "provider-message-2",
              role: "assistant",
              content: "Saving another",
              toolCalls: [nextCall],
            },
          ]),
          {
            type: EventType.TOOL_CALL_START,
            parentMessageId: "provider-message-2",
            toolCallId: "call-2",
            toolCallName: "save_playbook",
          },
        ]),
      }),
    );
    expect(chunks).toEqual([
      buildWireSnapshot([
        { id: "user-1", role: "user", content: "Save the draft" },
        // The resumed run's iteration folds into the message it continues,
        // which the snapshot already carries from history.
        {
          id: owningMessageId,
          role: "assistant",
          content: "Saving the draft\n\nSaving another",
          toolCalls: [savedCall, nextCall],
        },
        {
          id: "call-1-result",
          role: "tool",
          toolCallId: "call-1",
          content: '{"playbookId":"playbook-1"}',
        },
      ]),
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: owningMessageId,
        toolCallId: "call-2",
        toolCallName: "save_playbook",
      },
    ]);
  });

  test("normalizes tanstack generated final assistant ids before persistence", () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const mapMessageId = createChatMessageIdMapper(() => messageId);

    expect(mapMessageId("provider-stream-message")).toBe(messageId);
    expect(
      normalizeFinalAssistantMessageId({
        mapMessageId,
        message: {
          id: "msg-1781251066139-vhjhi8",
          role: "assistant",
          parts: [
            {
              content: "Checking source law.",
              type: "thinking",
            },
            {
              arguments: "{}",
              id: "tool-1",
              name: "ask-user",
              state: "input-complete",
              type: "tool-call",
            },
          ],
        },
      }),
    ).toEqual(
      toPersistableChatMessage({
        id: messageId,
        role: "assistant",
        parts: [
          {
            content: "Checking source law.",
            type: "thinking",
          },
          {
            arguments: "{}",
            id: "tool-1",
            name: "ask-user",
            state: "input-complete",
            type: "tool-call",
          },
        ],
      }),
    );
  });

  test("persists a continuation's assistant output under the owning assistant id", () => {
    const owningMessageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );

    expect(
      normalizeFinalAssistantMessageId({
        mapMessageId: createTurnMessageIdMapper(owningMessageId),
        message: {
          id: "provider-reply",
          role: "assistant",
          parts: [{ content: "Approved action completed.", type: "text" }],
        },
      }).id,
    ).toBe(owningMessageId);
  });

  test("passes the owning assistant id through terminal turn finalization", async () => {
    const owningMessageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let persistedMessageId: string | undefined;
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      initialMessages: [{ id: owningMessageId, parts: [], role: "assistant" }],
      getResponseMessage: () => ({
        id: owningMessageId,
        role: "assistant",
        parts: [{ content: "Approved action completed.", type: "text" }],
      }),
      mapMessageId: createTurnMessageIdMapper(owningMessageId),
      onFinish: ({ responseMessage }) => {
        persistedMessageId = responseMessage.id;
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "stop",
          runId: "run-1",
          threadId: "thread-1",
        },
      ]),
    });

    await collectChunks(stream);
    expect(persistedMessageId).toBe(owningMessageId);
  });

  test("seeds tanstack message state before reasoning-only chunks", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const threadId = "thread-1";
    const mapMessageId = createChatMessageIdMapper(() => messageId);
    const responseMessageIds: string[] = [];
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessageIds.push(message.id);
        },
      },
    });
    const chunks = ensureAssistantMessageStart({
      getOrCreateMessageId: () => mapMessageId("assistant-response"),
      source: remapOutgoingMessageIds({
        mapMessageId,
        source: streamChunks([
          { type: EventType.RUN_STARTED, runId: "run-1", threadId },
          {
            type: EventType.REASONING_MESSAGE_CONTENT,
            delta: "Checking source law.",
            messageId: "openrouter-reasoning-message",
          },
          {
            type: EventType.REASONING_MESSAGE_END,
            messageId: "openrouter-reasoning-message",
          },
          {
            type: EventType.RUN_FINISHED,
            finishReason: "stop",
            runId: "run-1",
            threadId,
          },
        ]),
      }),
    });

    const emitted = await collectChunks(chunks);
    for (const chunk of emitted) {
      processor.processChunk(chunk);
    }

    expect(stripTimestamps(emitted)).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "Checking source law.",
        messageId,
      },
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId,
      },
      {
        type: EventType.RUN_FINISHED,
        // The engine moves `finishReason` off the top level, so the pipeline
        // forwards it where a spec consumer reads it.
        metadata: { tanstack: { finishReason: "stop" } },
        runId: "run-1",
        threadId,
      },
    ]);
    expect(responseMessageIds).toEqual([messageId]);
  });

  test("defers run finished until assistant persistence has completed", async () => {
    const events: string[] = [];
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          events.push("processor:onStreamEnd");
          responseMessage = {
            id: message.id,
            parts: [{ content: "Ahoj", type: "text" }],
            role: "assistant",
          };
        },
      },
    });
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: () => {
        events.push("server:onFinish");
      },
      processor,
      source: streamChunks([
        {
          type: EventType.RUN_STARTED,
          runId: "run-1",
          threadId: "thread-1",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Ahoj",
          messageId: "provider-message",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "provider-message",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "stop",
          runId: "run-1",
          threadId: "thread-1",
        },
      ]),
    });

    const emittedTypes: string[] = [];
    for await (const chunk of stream) {
      emittedTypes.push(chunk.type);
      events.push(`yield:${chunk.type}`);
    }

    expect(emittedTypes).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events).toEqual([
      "yield:RUN_STARTED",
      "yield:TEXT_MESSAGE_START",
      "yield:TEXT_MESSAGE_CONTENT",
      "yield:TEXT_MESSAGE_END",
      "processor:onStreamEnd",
      "server:onFinish",
      "yield:RUN_FINISHED",
    ]);
  });

  test("flushes a completed primary run before a fallback run starts", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = {
            id: message.id,
            parts: [{ content: "Fallback answer", type: "text" }],
            role: "assistant",
          };
        },
      },
    });
    const persistedTexts: string[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ responseMessage: finishedMessage }) => {
        persistedTexts.push(
          finishedMessage.parts
            .map((part) => (part.type === "text" ? part.content : ""))
            .join(""),
        );
      },
      processor,
      source: streamChunks([
        {
          type: EventType.RUN_STARTED,
          runId: "primary-run",
          threadId: "thread-1",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "stop",
          runId: "primary-run",
          threadId: "thread-1",
        },
        {
          type: EventType.RUN_STARTED,
          runId: "fallback-run",
          threadId: "thread-1",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Fallback answer",
          messageId: "provider-message",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "provider-message",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "stop",
          runId: "fallback-run",
          threadId: "thread-1",
        },
      ]),
    });

    const lifecycle = (await collectChunks(stream)).flatMap((chunk) =>
      chunk.type === EventType.RUN_STARTED ||
      chunk.type === EventType.RUN_FINISHED
        ? [`${chunk.type}:${chunk.runId}`]
        : [],
    );

    expect(lifecycle).toEqual([
      `${EventType.RUN_STARTED}:primary-run`,
      `${EventType.RUN_FINISHED}:primary-run`,
      `${EventType.RUN_STARTED}:fallback-run`,
      `${EventType.RUN_FINISHED}:fallback-run`,
    ]);
    expect(persistedTexts).toEqual(["Fallback answer"]);
  });

  test("persists a client tool requested after a completed server-tool run", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = toChatMessage(message);
        },
      },
    });
    let persistedToolCalls: { input: unknown; name: string }[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ responseMessage: finishedMessage }) => {
        persistedToolCalls = finishedMessage.parts.flatMap((part) =>
          part.type === "tool-call"
            ? [{ input: part.input, name: part.name }]
            : [],
        );
      },
      processor,
      source: streamChunks([
        {
          type: EventType.RUN_STARTED,
          runId: "list-run",
          threadId: "thread-1",
        },
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-list-message",
          toolCallId: "list-call",
          toolCallName: "list_templates",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta: '{"category":"contract"}',
          toolCallId: "list-call",
        },
        {
          type: EventType.TOOL_CALL_END,
          toolCallId: "list-call",
        },
        {
          type: EventType.TOOL_CALL_RESULT,
          content: '{"templates":[]}',
          messageId: "provider-list-message",
          toolCallId: "list-call",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "tool_calls",
          runId: "list-run",
          threadId: "thread-1",
        },
        {
          type: EventType.RUN_STARTED,
          runId: "ask-run",
          threadId: "thread-1",
        },
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-ask-message",
          toolCallId: "ask-call",
          toolCallName: "ask-user",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta:
            '{"question":"What scope should the power of attorney cover?"}',
          toolCallId: "ask-call",
        },
        {
          type: EventType.TOOL_CALL_END,
          input: {
            question: "What scope should the power of attorney cover?",
          },
          toolCallId: "ask-call",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "tool_calls",
          runId: "ask-run",
          threadId: "thread-1",
        },
        {
          type: EventType.CUSTOM,
          name: "tool-input-available",
          value: {
            input: {
              question: "What scope should the power of attorney cover?",
            },
            toolCallId: "ask-call",
            toolName: "ask-user",
          },
        },
      ]),
    });

    const chunks = await collectChunks(stream);
    let clientToolCalls: { input: unknown; name: string }[] = [];
    const clientProcessor = new StreamProcessor({
      events: {
        onMessagesChange: (messages) => {
          const assistant = messages.findLast(
            (message) => message.role === "assistant",
          );
          clientToolCalls =
            assistant?.parts.flatMap((part) =>
              part.type === "tool-call"
                ? [{ input: part.input, name: part.name }]
                : [],
            ) ?? [];
        },
      },
    });
    for (const chunk of chunks) {
      clientProcessor.processChunk(chunk);
    }

    expect(persistedToolCalls).toEqual([
      { input: { category: "contract" }, name: "list_templates" },
      {
        input: {
          question: "What scope should the power of attorney cover?",
        },
        name: "ask-user",
      },
    ]);
    expect(persistedToolCalls).toEqual(clientToolCalls);
  });

  test("persists approval requests emitted after a model run finishes", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          const toolCall = message.parts.find(
            (part): part is ToolCallPart =>
              part.type === "tool-call" && part.id === "tool-1",
          );
          if (!toolCall) {
            throw new Error("Expected web-search tool call");
          }
          responseMessage = {
            id: message.id,
            parts: [
              {
                arguments: toolCall.arguments,
                id: toolCall.id,
                name: "web_search",
                state: toolCall.state,
                type: "tool-call",
                ...(toolCall.approval === undefined
                  ? {}
                  : { approval: toolCall.approval }),
              },
            ],
            role: "assistant",
          };
        },
      },
    });
    let persistedState: string | undefined;
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ responseMessage: finishedMessage }) => {
        const part = finishedMessage.parts.at(0);
        persistedState = part?.type === "tool-call" ? part.state : undefined;
      },
      processor,
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-message",
          toolCallId: "tool-1",
          toolCallName: "web_search",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta: '{"query":"Winston Churchill quotes"}',
          toolCallId: "tool-1",
        },
        {
          type: EventType.TOOL_CALL_END,
          input: { query: "Winston Churchill quotes" },
          toolCallId: "tool-1",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "tool_calls",
          runId: "run-1",
          threadId: "thread-1",
        },
        {
          type: EventType.CUSTOM,
          name: "approval-requested",
          value: {
            approval: { id: "approval_tool-1", needsApproval: true },
            input: { query: "Winston Churchill quotes" },
            toolCallId: "tool-1",
            toolName: "web_search",
          },
        },
      ]),
    });

    const chunks = await collectChunks(stream);
    let clientState: string | undefined;
    const clientProcessor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          const part = message.parts.find(
            (candidate) =>
              candidate.type === "tool-call" && candidate.id === "tool-1",
          );
          clientState = part?.type === "tool-call" ? part.state : undefined;
        },
      },
    });
    for (const chunk of chunks) {
      clientProcessor.processChunk(chunk);
    }
    // The SDK finalizes when it drives the stream itself; a replay that feeds
    // chunks one by one ends the turn here, as the client does.
    clientProcessor.finalizeStream();

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);
    expect(persistedState).toBe(clientState);
    expect(persistedState).toBe("approval-requested");
  });

  test("persists partial assistant messages when the stream aborts after content", async () => {
    const abortController = new AbortController();
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = {
            id: message.id,
            parts: [
              {
                content: message.parts
                  .map((part) => (part.type === "text" ? part.content : ""))
                  .join(""),
                type: "text",
              },
            ],
            role: message.role,
          };
        },
      },
    });
    const finishEvents: { outcome: string; text: string }[] = [];

    const stream = processServerChatStream({
      abortSignal: abortController.signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome, responseMessage: finishedMessage }) => {
        finishEvents.push({
          outcome: outcome.type,
          text: finishedMessage.parts
            .map((part) => (part.type === "text" ? part.content : ""))
            .join(""),
        });
      },
      processor,
      source: streamChunksThenAbort({
        abortController,
        chunks: [
          {
            type: EventType.RUN_STARTED,
            runId: "run-1",
            threadId: "thread-1",
          },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "provider-message",
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            delta: "Partial answer",
            messageId: "provider-message",
          },
        ],
      }),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Partial answer",
        messageId,
      },
      {
        type: EventType.RUN_ERROR,
        message: "unknown",
        code: "unknown",
      },
    ]);
    expect(finishEvents).toEqual([
      { outcome: "interrupted", text: "Partial answer" },
    ]);
  });

  test("normalizes in-band provider run errors", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => null,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.RUN_ERROR,
          message: "upstream quota",
          rawEvent: { statusCode: 429 },
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
      // The turn's message is named before the error.
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.RUN_ERROR,
        message: "quota_exhausted",
        code: "quota_exhausted",
      },
    ]);
    expect(outcomes).toEqual(["failed"]);
  });

  test("normalizes a credential rejection emitted by the installed OpenAI adapter", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const adapter = createOpenaiChat("gpt-5.4-mini", "test-api-key", {
      baseURL: "https://provider.invalid/v1",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_api_key",
              message: "Incorrect API key",
              param: null,
              type: "invalid_request_error",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 401,
          },
        ),
    });
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => null,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor: new StreamProcessor(),
      source: chat({
        adapter,
        messages: [{ content: "Hello", role: "user" }],
      }),
    });

    const chunks = await collectChunks(stream);
    expect(
      chunks.find((chunk) => chunk.type === EventType.RUN_ERROR),
    ).toMatchObject({
      code: "provider_credentials_rejected",
      message: "provider_credentials_rejected",
      type: EventType.RUN_ERROR,
    });
    expect(outcomes).toEqual(["failed"]);
  });

  test("reports provider status for an in-band unknown failure", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const errorSpy = spyOn(logger, "error");
    try {
      const stream = processServerChatStream({
        abortSignal: new AbortController().signal,
        deadlineSignal: new AbortController().signal,
        getResponseMessage: () => null,
        initialMessages: [],
        mapMessageId: createChatMessageIdMapper(() => messageId),
        onFinish: () => undefined,
        processor: new StreamProcessor(),
        source: streamChunks([
          { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
          {
            type: EventType.RUN_ERROR,
            message: "provider request forbidden",
            rawEvent: { statusCode: 403 },
          },
        ]),
      });

      await collectChunks(stream);

      expect(errorSpy).toHaveBeenCalledWith("chat.stream_failed", {
        kind: "unknown",
        "error.class": "UnknownError",
        "error.provider.reason": "unrecognized",
        "error.provider.status": "403",
        "failure.shadow_grade": "defect",
        "failure.shadow_reason": "unclassified",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("names the template of a refused OpenAI request, never its text", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const errorSpy = spyOn(logger, "error");
    try {
      const stream = processServerChatStream({
        abortSignal: new AbortController().signal,
        deadlineSignal: new AbortController().signal,
        getResponseMessage: () => null,
        initialMessages: [],
        mapMessageId: createChatMessageIdMapper(() => messageId),
        onFinish: () => undefined,
        processor: new StreamProcessor(),
        source: streamChunks([
          { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
          {
            type: EventType.RUN_ERROR,
            message:
              "Item 'rs_0a1b' of type 'reasoning' was provided without its required following item.",
            rawEvent: { statusCode: 400 },
          },
        ]),
      });

      await collectChunks(stream);

      expect(errorSpy).toHaveBeenCalledWith(
        "chat.stream_failed",
        expect.objectContaining({
          "error.provider.reason": "reasoning_without_following_item",
          "error.provider.status": "400",
        }),
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("rs_0a1b");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("does not report an in-band configuration refusal as a defect", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const errorSpy = spyOn(logger, "error");
    try {
      const stream = processServerChatStream({
        abortSignal: new AbortController().signal,
        deadlineSignal: new AbortController().signal,
        getResponseMessage: () => null,
        initialMessages: [],
        mapMessageId: createChatMessageIdMapper(() => messageId),
        onFinish: () => undefined,
        processor: new StreamProcessor(),
        source: streamChunks([
          { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
          {
            type: EventType.RUN_ERROR,
            message: "AI is not configured for this role",
            rawEvent: new HandlerError({
              status: 403,
              message: "AI is not configured for this role",
            }),
          },
        ]),
      });

      expect(stripTimestamps(await collectChunks(stream)).at(-1)).toEqual({
        type: EventType.RUN_ERROR,
        message: "unknown",
        code: "unknown",
      });
      expect(errorSpy).not.toHaveBeenCalledWith(
        "chat.stream_failed",
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("classifies a run error whose body arrives in the message", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => null,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.RUN_ERROR,
          message: JSON.stringify({
            error: {
              code: 503,
              message: "The model is currently overloaded.",
              status: "UNAVAILABLE",
            },
          }),
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
      // The turn's message is named before the error.
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.RUN_ERROR,
        message: "provider_unavailable",
        code: "provider_unavailable",
      },
    ]);
    expect(outcomes).toEqual(["failed"]);
  });

  test("classifies a run error body behind leading whitespace", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => null,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.RUN_ERROR,
          message: `\n  ${JSON.stringify({ error: { code: 429 } })}`,
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream)).at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "quota_exhausted",
      code: "quota_exhausted",
    });
    expect(outcomes).toEqual(["failed"]);
  });

  test("leaves a plain-text run error unclassified", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => null,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        { type: EventType.RUN_ERROR, message: "something went wrong" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
      // The turn's message is named before the error.
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.RUN_ERROR,
        message: "unknown",
        code: "unknown",
      },
    ]);
    expect(outcomes).toEqual(["failed"]);
  });

  test("does not finish successfully after an in-band run error", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => null,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Partial answer",
          messageId: "provider-message",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "provider-message",
        },
        {
          type: EventType.RUN_ERROR,
          message: "upstream billing",
          rawEvent: { statusCode: 402 },
        },
      ]),
    });

    const chunks = await collectChunks(stream);

    expect(stripTimestamps(chunks).at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "provider_billing",
      code: "provider_billing",
    });
    expect(outcomes).toEqual(["failed"]);
  });
});

describe("interrupt snapshot assistant message identity", () => {
  const owningMessageId = toSafeId<"chatMessage">(
    "11111111-1111-4111-8111-111111111111",
  );
  const userMessage: ChatMessage = {
    id: "user-1",
    role: "user",
    parts: [{ content: "Build a playbook", type: "text" }],
  };

  type ChatMessagePart = ChatMessage["parts"][number];
  type ToolCallChatPart = Extract<ChatMessagePart, { type: "tool-call" }>;

  const pendingCall = (id: string): ToolCallChatPart => ({
    arguments: '{"question":"Which side?"}',
    id,
    input: { question: "Which side?" },
    name: "ask-user",
    state: "input-complete",
    type: "tool-call",
  });

  /** A tool call the user has answered, followed by its result part. */
  const answeredCall = (id: string): [ToolCallChatPart, ChatMessagePart] => [
    {
      arguments: '{"question":"Which side?"}',
      id,
      input: { question: "Which side?" },
      name: "ask-user",
      output: { answers: [{ answer: id, question: "Which side?" }] },
      state: "complete",
      type: "tool-call",
    },
    {
      content: JSON.stringify({ answers: [{ answer: id }] }),
      state: "complete",
      toolCallId: id,
      type: "tool-result",
    },
  ];

  type RemapSnapshotOptions = {
    history: readonly ChatMessage[];
    mapMessageId: MessageIdMapper;
    /** The engine's own messages for this run, which carry provider metadata. */
    run: readonly UIMessage[];
  };

  const remapSnapshot = async ({
    history,
    mapMessageId,
    run,
  }: RemapSnapshotOptions) => {
    const input = buildEngineSnapshot([...history, ...run]);
    const [output] = await collectChunks(
      remapOutgoingMessageIds({
        existingMessageIds: new Set(history.map(({ id }) => id)),
        mapMessageId,
        source: streamChunks([input]),
      }),
    );
    if (output?.type !== EventType.MESSAGES_SNAPSHOT) {
      throw new Error("Expected one messages snapshot");
    }
    return { input: input.messages, output: output.messages, snapshot: output };
  };

  type RemappedSnapshot = Awaited<ReturnType<typeof remapSnapshot>>;
  type SnapshotMessages = RemappedSnapshot["output"];

  const assistantToolCalls = (messages: SnapshotMessages) =>
    messages.flatMap((message) =>
      message.role === "assistant"
        ? [
            {
              id: message.id,
              toolCallIds: (message.toolCalls ?? []).map(({ id }) => id),
            },
          ]
        : [],
    );

  const toolResultIds = (messages: SnapshotMessages) =>
    messages.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    );

  /** What the browser renders from the remapped snapshot. */
  const clientMessages = ({
    history,
    snapshot,
  }: {
    history: readonly ChatMessage[];
    snapshot: RemappedSnapshot["snapshot"];
  }) => {
    const processor = new StreamProcessor({ initialMessages: [...history] });
    processor.processChunk(snapshot);
    return processor.getMessages();
  };

  test("carries a continuation's owning message once, although an earlier tool result split it", async () => {
    const history = [
      userMessage,
      {
        id: owningMessageId,
        role: "assistant",
        parts: [...answeredCall("load-skill"), ...answeredCall("ask-1")],
      } satisfies ChatMessage,
    ];
    const { output, snapshot } = await remapSnapshot({
      history,
      mapMessageId: createTurnMessageIdMapper(owningMessageId),
      run: [
        {
          id: "provider-message-2",
          role: "assistant",
          parts: [pendingCall("ask-2")],
        },
      ],
    });

    expect(assistantToolCalls(output)).toEqual([
      { id: owningMessageId, toolCallIds: ["load-skill", "ask-1", "ask-2"] },
    ]);
    expect(toolResultIds(output)).toEqual(["load-skill", "ask-1"]);
    expect(
      clientMessages({ history, snapshot })
        .filter(({ role }) => role === "assistant")
        .map(({ id, parts }) => ({
          id,
          toolCallIds: parts.flatMap((part) =>
            part.type === "tool-call" ? [part.id] : [],
          ),
        })),
    ).toEqual([
      { id: owningMessageId, toolCallIds: ["load-skill", "ask-1", "ask-2"] },
    ]);
  });

  test("carries a split historical assistant message once beside a fresh turn", async () => {
    const turnMessageId = toSafeId<"chatMessage">(
      "22222222-2222-4222-8222-222222222222",
    );
    const history = [
      userMessage,
      {
        id: "assistant-previous",
        role: "assistant",
        parts: [
          ...answeredCall("lookup-1"),
          { content: "Found two", type: "text" },
          ...answeredCall("lookup-2"),
        ],
      } satisfies ChatMessage,
      {
        id: "user-2",
        role: "user",
        parts: [{ content: "Now ask me", type: "text" }],
      } satisfies ChatMessage,
    ];
    const { output } = await remapSnapshot({
      history,
      mapMessageId: createChatMessageIdMapper(() => turnMessageId),
      run: [
        {
          id: "provider-message-1",
          role: "assistant",
          parts: [pendingCall("ask-1")],
        },
      ],
    });

    expect(assistantToolCalls(output)).toEqual([
      { id: "assistant-previous", toolCallIds: ["lookup-1", "lookup-2"] },
      { id: turnMessageId, toolCallIds: ["ask-1"] },
    ]);
    expect(output.find(({ id }) => id === "assistant-previous")).toMatchObject({
      content: "Found two",
    });
    expect(output.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);
  });

  test("keeps the tool-call metadata of every merged copy", async () => {
    const history = [
      userMessage,
      {
        id: owningMessageId,
        role: "assistant",
        parts: [...answeredCall("load-skill"), ...answeredCall("ask-1")],
      } satisfies ChatMessage,
    ];
    const [askTwo, askTwoResult] = answeredCall("ask-2");
    const { snapshot } = await remapSnapshot({
      history,
      mapMessageId: createTurnMessageIdMapper(owningMessageId),
      run: [
        {
          id: "provider-message-2",
          role: "assistant",
          parts: [
            { ...askTwo, metadata: { signature: "ask-2" } },
            askTwoResult,
          ],
        },
        {
          id: "provider-message-3",
          role: "assistant",
          parts: [
            { ...pendingCall("ask-3"), metadata: { signature: "ask-3" } },
          ],
        },
      ],
    });

    expect(
      clientMessages({ history, snapshot }).flatMap(({ parts }) =>
        parts.flatMap((part) =>
          part.type === "tool-call"
            ? [{ id: part.id, metadata: part.metadata }]
            : [],
        ),
      ),
    ).toEqual([
      { id: "load-skill", metadata: undefined },
      { id: "ask-1", metadata: undefined },
      { id: "ask-2", metadata: { signature: "ask-2" } },
      { id: "ask-3", metadata: { signature: "ask-3" } },
    ]);
  });

  test("moves a split copy's reasoning before the merged message", async () => {
    const history = [
      userMessage,
      {
        id: owningMessageId,
        role: "assistant",
        parts: [
          { content: "Load the skill first", type: "thinking" },
          ...answeredCall("load-skill"),
          { content: "Then ask for the side", type: "thinking" },
          pendingCall("ask-1"),
        ],
      } satisfies ChatMessage,
    ];
    const { output, snapshot } = await remapSnapshot({
      history,
      mapMessageId: createTurnMessageIdMapper(owningMessageId),
      run: [],
    });

    expect(output.map(({ role }) => role)).toEqual([
      "user",
      "reasoning",
      "reasoning",
      "assistant",
      "tool",
    ]);
    const assistants = clientMessages({ history, snapshot }).filter(
      ({ role }) => role === "assistant",
    );
    expect(
      assistants.map(({ id, parts }) => ({
        id,
        thinking: parts.flatMap((part) =>
          part.type === "thinking" ? [part.content] : [],
        ),
      })),
    ).toEqual([
      {
        id: owningMessageId,
        thinking: ["Load the skill first", "Then ask for the side"],
      },
    ]);
  });

  test("emits one assistant message per id and every tool call once, in order", async () => {
    const cases = [1, 2, 3, 4].flatMap((copies) =>
      [0, 1, 2].map((runMessages) => ({ copies, runMessages })),
    );
    for (const { copies, runMessages } of cases) {
      const owningParts: ChatMessagePart[] = [];
      for (let index = 1; index < copies; index += 1) {
        owningParts.push(...answeredCall(`answered-${String(index)}`));
      }
      owningParts.push(pendingCall("pending"));
      const { input, output } = await remapSnapshot({
        history: [
          userMessage,
          { id: owningMessageId, role: "assistant", parts: owningParts },
        ],
        mapMessageId: createTurnMessageIdMapper(owningMessageId),
        run: Array.from({ length: runMessages }, (_, index) => ({
          id: `provider-message-${String(index + 1)}`,
          role: "assistant",
          parts: [pendingCall(`new-${String(index + 1)}`)],
        })),
      });

      const context = { copies, runMessages };
      const outputAssistants = assistantToolCalls(output);
      expect({ context, ids: outputAssistants.map(({ id }) => id) }).toEqual({
        context,
        ids: [owningMessageId],
      });
      expect({
        context,
        toolCallIds: outputAssistants.flatMap(({ toolCallIds }) => toolCallIds),
      }).toEqual({
        context,
        toolCallIds: assistantToolCalls(input).flatMap(
          ({ toolCallIds }) => toolCallIds,
        ),
      });
      expect({ context, toolResultIds: toolResultIds(output) }).toEqual({
        context,
        toolResultIds: toolResultIds(input),
      });
    }
  });
});

describe("chat stream client-disconnect persistence", () => {
  const messageId = toSafeId<"chatMessage">(
    "11111111-1111-4111-8111-111111111111",
  );

  const accumulatingProcessor = (): {
    getResponseMessage: () => ChatMessage | null;
    processor: StreamProcessor;
  } => {
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = {
            id: message.id,
            parts: [
              {
                content: message.parts
                  .map((part) => (part.type === "text" ? part.content : ""))
                  .join(""),
                type: "text",
              },
            ],
            role: message.role,
          };
        },
      },
    });
    return { getResponseMessage: () => responseMessage, processor };
  };

  const textOf = (message: { parts: ChatMessage["parts"] }) =>
    message.parts
      .map((part) => (part.type === "text" ? part.content : ""))
      .join("");

  // A dropped client connection aborts the provider call and `.return()`s the
  // stream generator mid-run. The partial content produced before the abort
  // must be persisted (finish reported as not aborted) rather than lost.
  test("persists the accumulated assistant message when the client disconnects mid-stream", async () => {
    const abortSignal = new AbortController().signal;
    const { getResponseMessage, processor } = accumulatingProcessor();
    const finishEvents: { outcome: string; text: string }[] = [];

    const stream = processServerChatStream({
      abortSignal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome, responseMessage }) => {
        finishEvents.push({
          outcome: outcome.type,
          text: textOf(responseMessage),
        });
      },
      processor,
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Partial answer",
          messageId: "provider-message",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: " continues",
          messageId: "provider-message",
        },
      ]),
    });

    // Simulate the SSE consumer dropping mid-stream: read up to the first
    // content chunk, then break. Breaking a `for await` `.return()`s the
    // generator, running its teardown `finally`.
    for await (const chunk of stream) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        break;
      }
    }

    expect(finishEvents).toEqual([
      { outcome: "interrupted", text: "Partial answer" },
    ]);
    expect(abortSignal.aborted).toBe(false);
  });

  test("preserves unfinished tool arguments when the client disconnects", async () => {
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = toChatMessage(message);
        },
      },
    });
    let persistedParts: ChatMessage["parts"] = [];
    const persistenceVisible = transformPersistenceVisibleStream({
      boundary: createBoundary([["[PERSON_1]", "Jan Novak"]]),
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-message",
          toolCallId: "search-call",
          toolCallName: "ask-user",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta: '{"question":"[PER',
          toolCallId: "search-call",
        },
      ]),
    });
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      flushPendingSource: persistenceVisible.flushPending,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ responseMessage: finishedMessage }) => {
        persistedParts = finishedMessage.parts;
      },
      processor,
      source: persistenceVisible,
    });

    for await (const chunk of stream) {
      if (chunk.type === EventType.TOOL_CALL_ARGS) {
        break;
      }
    }

    expect(persistedParts).toEqual([
      {
        arguments: '{"question":"[PER',
        id: "search-call",
        name: "ask-user",
        state: "input-streaming",
        type: "tool-call",
      },
    ]);
  });

  test("runs the finish callback exactly once on natural completion", async () => {
    const { getResponseMessage, processor } = accumulatingProcessor();
    let finishCount = 0;

    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: () => {
        finishCount += 1;
      },
      processor,
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Done",
          messageId: "provider-message",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "provider-message" },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "stop",
          runId: "run-1",
          threadId: "thread-1",
        },
      ]),
    });

    await collectChunks(stream);

    // The after-loop finish persists once; the teardown `finally` must not
    // double-write on a fully drained stream.
    expect(finishCount).toBe(1);
  });

  test("settles an interrupted turn when the client disconnects before content", async () => {
    const { getResponseMessage, processor } = accumulatingProcessor();
    const outcomes: string[] = [];

    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor,
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
      ]),
    });

    // Pull the first chunk, then `.return()` the generator before any assistant
    // text is processed — the explicit form of the consumer dropping mid-stream.
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(outcomes).toEqual(["interrupted"]);
  });
});

describe("chat message usage metadata", () => {
  test("preserves provider-reported reasoning tokens", () => {
    expect(
      chatMessageUsageFromTokenUsage({
        completionTokens: 22,
        completionTokensDetails: { reasoningTokens: 12 },
        promptTokens: 10,
        totalTokens: 32,
      }),
    ).toEqual({
      completionTokens: 22,
      completionTokensDetails: { reasoningTokens: 12 },
      promptTokens: 10,
      totalTokens: 32,
    });
  });
});

describe("streamed chat message conversion", () => {
  for (const richPart of richChatParts) {
    test(`persists a streamed ${richPart.type} part with its surrounding text`, () => {
      const message = toChatMessage({
        id: "assistant-message",
        role: "assistant",
        parts: [
          { content: "Dobrý den", type: "text" },
          richPart,
          { content: "Na shledanou", type: "text" },
        ],
      });

      expect(message?.parts).toEqual([
        { content: "Dobrý den", type: "text" },
        richPart,
        { content: "Na shledanou", type: "text" },
      ]);
    });
  }

  test("settles a part-less completion as a failed turn", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    // A provider can finish without emitting content. Finishing that turn
    // would insert a blank assistant message into the history.
    const responseMessage: ChatMessage = {
      id: messageId,
      parts: [],
      role: "assistant",
    };
    const processor = new StreamProcessor({ events: {} });

    await collectChunks(
      processServerChatStream({
        abortSignal: new AbortController().signal,
        deadlineSignal: new AbortController().signal,
        getResponseMessage: () => responseMessage,
        initialMessages: [],
        mapMessageId: createChatMessageIdMapper(() => messageId),
        onFinish: ({ outcome }) => {
          outcomes.push(outcome.type);
        },
        processor,
        source: streamChunks([
          { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
          {
            type: EventType.RUN_FINISHED,
            finishReason: "stop",
            runId: "run-1",
            threadId: "thread-1",
          },
        ]),
      }),
    );

    expect(outcomes).toEqual(["failed"]);
  });

  // The teardown `finally` reaches the same settlement boundary by a different
  // route, so a dropped connection still closes the durable turn.
  test("settles a part-less turn when the client disconnects", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const outcomes: string[] = [];
    const responseMessage: ChatMessage = {
      id: messageId,
      parts: [],
      role: "assistant",
    };
    const processor = new StreamProcessor({ events: {} });

    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ outcome }) => {
        outcomes.push(outcome.type);
      },
      processor,
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Dobrý den",
          messageId: "provider-message",
        },
      ]),
    });

    // Breaking the `for await` `.return()`s the generator, running the teardown
    // `finally` that calls `finalizeInterruptedResponseMessage`.
    for await (const chunk of stream) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        break;
      }
    }

    expect(outcomes).toEqual(["interrupted"]);
  });
});

describe("guarded model-ingress seam", () => {
  // Behavioural coverage of the guard itself (redaction, telemetry, panic)
  // lives in `lib/chat/model-ingress-guard.test.ts`, where the analytics
  // capture is mocked. This pins the wiring: the surfaces the chat dispatch
  // accepts are exactly the ones the guard mints.
  const workspaceIds = [
    toSafeId<"workspace">("0dc54d0c-10d7-501d-897e-e801dbd0998c"),
  ];
  const publicDecisionId = "7c0f7d51-70a4-4d64-9f0e-0a4d64e9911b";

  test("only guard-minted surfaces satisfy the dispatch bundle", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        parts: [{ content: `Cite ${publicDecisionId}`, type: "text" }],
        role: "user",
      },
    ];
    const tools: ChatTool[] = [];
    const system = "You are stella. Matter scope: mat_1.";

    const surfaces: GuardedChatSurfaces = {
      messages: guardProviderHistory({ messages, workspaceIds }),
      system: guardModelSystemPrompt({ system, workspaceIds }),
      systemLayers: buildGlobalPromptParts({ userContext: null }).safeLayers,
      tenantWorkspaceIds: workspaceIds,
      tools: guardModelToolSchemas({ tools, workspaceIds }),
    };

    // What `runChatAttempt` widens the brands back into for the provider SDK.
    const dispatchedMessages: ChatMessage[] = surfaces.messages;
    const dispatchedSystem: string = surfaces.system;

    // The guard hands the model its own copy; the same reference reaching the
    // dispatch would mean the messages skipped it.
    expect(dispatchedMessages).not.toBe(messages);
    expect(dispatchedMessages).toEqual(messages);
    // Membership-exact: a public decision UUID is not a tenant id.
    expect(dispatchedMessages[0]?.parts[0]).toEqual({
      content: `Cite ${publicDecisionId}`,
      type: "text",
    });
    expect(dispatchedSystem).toBe(system);

    const unguarded = {
      messages,
      system,
      tenantWorkspaceIds: workspaceIds,
      tools,
    };
    // @ts-expect-error surfaces that skipped the model-ingress guard must not
    // reach the provider dispatch
    const bypass: GuardedChatSurfaces = unguarded;
    void bypass;

    const unanswered = {
      ...surfaces,
      messages: guardModelMessages({ messages, workspaceIds }),
    };
    // @ts-expect-error a history whose calls were not answered in their step
    // must not reach the provider dispatch
    const skippedAnswers: GuardedChatSurfaces = unanswered;
    void skippedAnswers;
  });
});

describe("chat attempt terminal classification", () => {
  test("does not cross execution boundaries to fallback an agent run", () => {
    expect(
      shouldAttemptChatFallback({
        hasFallbackModel: true,
        hasNativeContinuation: false,
        primaryError: new ChatEmptyCompletionError({ message: "empty" }),
        runMode: CHAT_RUN_MODE.agent,
      }),
    ).toBe(false);
  });

  test("keeps empty-completion fallback for normal chat", () => {
    expect(
      shouldAttemptChatFallback({
        hasFallbackModel: true,
        hasNativeContinuation: false,
        primaryError: new ChatEmptyCompletionError({ message: "empty" }),
        runMode: undefined,
      }),
    ).toBe(true);
  });

  test("does not replay a native continuation through fallback", () => {
    expect(
      shouldAttemptChatFallback({
        hasFallbackModel: true,
        hasNativeContinuation: true,
        primaryError: new ChatEmptyCompletionError({ message: "empty" }),
        runMode: undefined,
      }),
    ).toBe(false);
  });

  test("captures a stop that streamed no answer", () => {
    const state = createChatAttemptState();
    const capturedErrors: unknown[] = [];

    recordChatAttemptFinish({
      captureError: (error) => {
        capturedErrors.push(error);
      },
      finishReason: "stop",
      messages: [],
      modelInfo: { modelId: "gpt-test", provider: "openai" },
      state,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111111"),
    });

    expect(state.emptyCompletion).toBeInstanceOf(ChatEmptyCompletionError);
    expect(state.finalLoopDetection).toBeNull();
    expect(capturedErrors).toEqual([state.emptyCompletion]);
  });

  test("keeps a stop that streamed an answer", () => {
    const state = { ...createChatAttemptState(), producedAnswer: true };

    recordChatAttemptFinish({
      captureError: () => {},
      finishReason: "stop",
      messages: [],
      modelInfo: { modelId: "gpt-test", provider: "openai" },
      state,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111111"),
    });

    expect(state.emptyCompletion).toBeNull();
  });

  test("surfaces final content loops", () => {
    const state = { ...createChatAttemptState(), producedAnswer: true };
    const loopChunk = "abcdefghij".repeat(5);
    const messages: ModelMessage[] = [
      { content: "Please answer.", role: "user" },
      { content: loopChunk.repeat(10), role: "assistant" },
    ];

    recordChatAttemptFinish({
      captureError: () => {},
      finishReason: "stop",
      messages,
      modelInfo: { modelId: "gpt-test", provider: "openai" },
      state,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111111"),
    });

    expect(state.finalLoopDetection).toBeInstanceOf(ChatLoopDetectedError);
    expect(state.emptyCompletion).toBeNull();
  });
});

const createBoundary = (
  pairs: readonly (readonly [string, string])[],
): Extract<ChatThirdPartyBoundary, { type: "anonymized" }> => ({
  anonymizationScopeId: "workspace-A",
  gazetteerEntries: Promise.resolve([]),
  excludedCanonicals: Promise.resolve([]),
  organizationId: toSafeId<"organization">("org_test"),
  pipelineContext: createPipelineContext(),
  placeholderOffsets: new Map<string, number>(),
  literalPlaceholderAliases: new Map<string, string>(),
  historicalRedactionMap: new Map<string, string>(),
  redactionMap: new Map(pairs),
  sourcePlaceholders: new Set<string>(),
  type: "anonymized",
});

// The pipeline under test consumes what `chat()` emits, so a hand-written
// fixture goes through the engine's own normalizer first: a non-spec key an
// adapter sets (`finishReason`, `input`) ends up where production finds it,
// rather than at the top level where only a synthetic chunk carries it.
const streamChunks = async function* (
  chunks: readonly StreamChunk[],
): AsyncIterable<PublicStreamChunk> {
  for (const chunk of chunks) {
    yield* normalizeStreamChunk(chunk);
  }
};

const streamChunksThenAbort = async function* ({
  abortController,
  chunks,
}: {
  abortController: AbortController;
  chunks: readonly StreamChunk[];
}): AsyncIterable<PublicStreamChunk> {
  yield* streamChunks(chunks);
  const error = new Error("Stream aborted");
  abortController.abort(error);
  throw error;
};

describe("native continuation third-party boundary", () => {
  test("anonymizes resolved payload text while preserving protocol fields", async () => {
    const boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }> = {
      ...createBoundary([]),
      anonymizeFields: async ({ fields }) =>
        Result.ok({
          entityCount: fields.filter((field) => field.includes("Jan Novak"))
            .length,
          fields: fields.map((field) =>
            field.replaceAll("Jan Novak", "[PERSON_1]"),
          ),
          redactionMap: new Map([["[PERSON_1]", "Jan Novak"]]),
        }),
    };

    const prepared = await prepareResumeForThirdParty({
      boundary,
      resume: [
        {
          interruptId: "interrupt-1",
          status: "resolved",
          payload: {
            answer: "Jan Novak approves the filing.",
            nested: ["Notify Jan Novak"],
            toolCallId: "tool_1",
          },
        },
        { interruptId: "interrupt-2", status: "cancelled" },
      ],
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toEqual([
      {
        interruptId: "interrupt-1",
        status: "resolved",
        payload: {
          answer: "[PERSON_1] approves the filing.",
          nested: ["Notify [PERSON_1]"],
          toolCallId: "tool_1",
        },
      },
      { interruptId: "interrupt-2", status: "cancelled" },
    ]);
    expect(boundary.redactionMap).toEqual(
      new Map([["[PERSON_1]", "Jan Novak"]]),
    );
  });
});

describe("chat stream refs", () => {
  test("keeps refs for persistence while resolving the client's copy", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const matterRef = registry.toMatterRef(workspaceId);
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    let persistedInput: unknown;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = toChatMessage(message);
        },
      },
    });
    const persistenceVisible = transformPersistenceVisibleStream({
      boundary: { type: "raw" },
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: "provider-message",
          toolCallId: "tool-1",
          toolCallName: "list_matters",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          delta: JSON.stringify({ matter_id: matterRef }),
          toolCallId: "tool-1",
        },
        // Shaped by the SDK's own normalizer, as `chat()` emits it: `input`
        // and `toolName` are not spec keys on TOOL_CALL_END, so the engine
        // moves them into `metadata.tanstack` before the chunk reaches this
        // pipeline. An adapter that parses the whole input on END (Anthropic)
        // delivers the canonical arguments there.
        ...normalizeStreamChunk({
          type: EventType.TOOL_CALL_END,
          input: { matter_id: matterRef },
          toolCallId: "tool-1",
          toolName: "list_matters",
        }),
        ...normalizeStreamChunk({
          type: EventType.RUN_FINISHED,
          finishReason: "tool_calls",
          runId: "run-1",
          threadId: "thread-1",
        }),
      ]),
    });
    const processed = processServerChatStream({
      abortSignal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      initialMessages: [],
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ responseMessage: terminalMessage }) => {
        const toolCall = terminalMessage.parts.find(
          (part) => part.type === "tool-call" && part.id === "tool-1",
        );
        persistedInput =
          toolCall?.type === "tool-call" && "input" in toolCall
            ? toolCall.input
            : undefined;
      },
      processor,
      source: persistenceVisible,
    });
    const clientChunks = await collectChunks(
      transformClientVisibleStream({
        resolveAssistantToolInputRefs: ({ input, toolName }) =>
          resolveRegistryToolInputRefs({
            input,
            refRegistry: registry,
            toolName,
          }),
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
        source: processed,
        storedHistory: NOTHING_REWRITTEN,
      }),
    );

    expect(persistedInput).toEqual({ matter_id: matterRef });
    const toolCallEnd = clientChunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_END,
    );
    expect(toolCallEnd).toMatchObject({ input: { matter_id: workspaceId } });
  });

  test("resolves the refs of a denied call's message in the snapshot the client reads", async () => {
    const ref = "#stella-entity-ref=ent_1";
    const resolved = "#stella-entity=workspace_1:entity_1";
    const history: ChatMessage[] = [
      {
        id: "user-1",
        parts: [{ content: "Delete the NDA", type: "text" }],
        role: "user",
      },
      {
        id: "assistant-1",
        parts: [
          { content: `Deleting [NDA](${ref}).`, type: "text" },
          {
            approval: {
              approved: false,
              id: "approval-1",
              needsApproval: true,
            },
            arguments: JSON.stringify({ name: `[NDA](${ref})` }),
            id: "call-1",
            input: { name: `[NDA](${ref})` },
            name: "mcp__external__delete",
            state: "approval-responded",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ];
    const deniedApprovals = findDeniedApprovals(history);
    // The fixture must reach the fault: the history holds a denied call.
    expect([...deniedApprovals.keys()]).toEqual(["call-1"]);

    const [snapshot] = await collectChunks(
      transformClientVisibleStream({
        deniedApprovals,
        resolveAssistantValueRefs: (value) =>
          JSON.parse(JSON.stringify(value).replaceAll(ref, () => resolved)),
        source: streamChunks([buildEngineSnapshot(history)]),
        storedHistory: NOTHING_REWRITTEN,
      }),
    );
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) {
      throw new Error("Expected one messages snapshot");
    }
    const assistant = snapshot.messages.find(({ id }) => id === "assistant-1");

    // The denied call's message travels with `parts`, which the client takes
    // as is: they must show what the rest of the stream shows.
    expect(assistant).toHaveProperty("parts");
    expect(JSON.stringify(assistant)).not.toContain(ref);
    expect(JSON.stringify(assistant)).toContain(resolved);
  });

  test("reports a failed served-history read as a terminal stream error", async () => {
    const chunks = await collectChunks(
      transformClientVisibleStream({
        source: streamChunks([
          buildEngineSnapshot([]),
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "later",
            delta: "later content",
          },
        ]),
        storedHistory: {
          loadServed: async () =>
            Result.err(
              new DatabaseError({ message: "sensitive storage detail" }),
            ),
          rewrittenOnAcceptance: [],
        },
      }),
    );

    expect(chunks).toEqual([
      {
        type: EventType.RUN_ERROR,
        code: "unknown",
        message: "unknown",
        timestamp: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(chunks)).not.toContain("sensitive storage detail");
  });

  test("resolves assistant text refs across streamed chunk boundaries", async () => {
    const chunks: StreamChunk[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Open [Document](",
        messageId: "text_1",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "#stella-entity-ref=",
        messageId: "text_1",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "ent_1) now.",
        messageId: "text_1",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text_1" },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: (text) =>
          text.replace(
            "#stella-entity-ref=ent_1",
            "#stella-entity=workspace_1:entity_1",
          ),
      }),
    );

    expect(collectText(resolvedChunks)).toBe(
      "Open [Document](#stella-entity=workspace_1:entity_1) now.",
    );
  });

  test("resolves assistant reasoning refs across streamed chunk boundaries", async () => {
    const chunks: StreamChunk[] = [
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "Check [Document](",
        messageId: "reasoning_1",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "#stella-entity-ref=",
        messageId: "reasoning_1",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "ent_1) first.",
        messageId: "reasoning_1",
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning_1" },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: (text) =>
          text.replace(
            "#stella-entity-ref=ent_1",
            "#stella-entity=workspace_1:entity_1",
          ),
      }),
    );

    expect(collectReasoning(resolvedChunks)).toBe(
      "Check [Document](#stella-entity=workspace_1:entity_1) first.",
    );
  });

  test("resolves newly created document mentions in assistant text", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const mention = registry.toEntityMention({
      entityId,
      label: "Mzuri_Umowa_Strona_1.docx",
      workspaceId,
    });

    const chunks: StreamChunk[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: `Utworzyłem nowy dokument ${mention}.`,
        messageId: "text_1",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text_1" },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: registry.resolveAssistantTextRefs,
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(collectText(resolvedChunks)).toBe(
      "Utworzyłem nowy dokument " +
        "[Mzuri_Umowa_Strona_1.docx](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34).",
    );
  });

  test("resolves refs in streamed tool outputs for the live UI", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const mention = registry.toEntityMention({
      entityId,
      label: "Mzuri_Umowa_Strona_1.docx",
      workspaceId,
    });

    const chunks: StreamChunk[] = [
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "message_1",
        toolCallId: "tool_1",
        content: JSON.stringify({
          fileName: "Mzuri_Umowa_Strona_1.docx",
          href: "#stella-entity-ref=ent_1",
          mention,
          success: true,
        }),
      },
    ];

    const [resolvedChunk] = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: registry.resolveAssistantTextRefs,
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(resolvedChunk).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "message_1",
      toolCallId: "tool_1",
      content: JSON.stringify({
        fileName: "Mzuri_Umowa_Strona_1.docx",
        href: "#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34",
        mention:
          "[Mzuri_Umowa_Strona_1.docx](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
        success: true,
      }),
    });
  });

  test("resolves streamed refs only at the registry tool's declared output paths", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const matterRef = registry.toMatterRef(workspaceId);
    const chunks: StreamChunk[] = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool_1",
        toolCallName: "list_matters",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "message_1",
        toolCallId: "tool_1",
        content: JSON.stringify({
          decisionId: matterRef,
          matters: [{ decisionId: matterRef, id: matterRef }],
        }),
      },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantToolOutputRefs: ({ output, toolName }) =>
          resolveRegistryToolOutputRefs({
            output,
            refRegistry: registry,
            toolName,
          }),
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(resolvedChunks.at(1)).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "message_1",
      toolCallId: "tool_1",
      content: JSON.stringify({
        decisionId: matterRef,
        matters: [{ decisionId: matterRef, id: workspaceId }],
      }),
    });
  });

  test("does not infer ref semantics for an undeclared tool payload", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");
    const matterRef = registry.toMatterRef(workspaceId);
    const entityRef = registry.toEntityRef({ entityId, workspaceId });
    const payload = { matterRef, nested: { entityRef } };
    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks([
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: "tool_1",
            toolCallName: "mcp__external__opaque",
          },
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: "message_1",
            toolCallId: "tool_1",
            content: JSON.stringify(payload),
          },
        ]),
        resolveAssistantToolOutputRefs: ({ output, toolName }) =>
          resolveRegistryToolOutputRefs({
            output,
            refRegistry: registry,
            toolName,
          }),
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(resolvedChunks.at(1)).toMatchObject({
      content: JSON.stringify(payload),
    });
  });

  test("restores declared snapshot inputs and outputs without inferring activity ref fields", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const matterRef = registry.toMatterRef(workspaceId);
    const [snapshot] = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks([
          unsafeFixture(
            "Unsupported activity role intentionally exercises non-engine snapshot extension preservation",
            {
              type: EventType.MESSAGES_SNAPSHOT,
              messages: [
                {
                  id: "assistant-1",
                  role: "assistant",
                  toolCalls: [
                    {
                      id: "tool-1",
                      type: "function",
                      function: {
                        arguments: JSON.stringify({ matter_id: matterRef }),
                        name: "list_matters",
                      },
                    },
                  ],
                },
                {
                  id: "tool-result-1",
                  role: "tool",
                  toolCallId: "tool-1",
                  content: JSON.stringify({
                    decisionId: matterRef,
                    matters: [{ decisionId: matterRef, id: matterRef }],
                  }),
                },
                {
                  id: "activity-1",
                  role: "activity",
                  activityType: "review",
                  content: { matterRef },
                },
              ],
            },
          ),
        ]),
        resolveAssistantToolInputRefs: ({ input, toolName }) =>
          resolveRegistryToolInputRefs({
            input,
            refRegistry: registry,
            toolName,
          }),
        resolveAssistantToolOutputRefs: ({ output, toolName }) =>
          resolveRegistryToolOutputRefs({
            output,
            refRegistry: registry,
            toolName,
          }),
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(snapshot).toEqual(
      unsafeFixture(
        "Unsupported activity role intentionally exercises non-engine snapshot extension preservation",
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              toolCalls: [
                {
                  id: "tool-1",
                  type: "function",
                  function: {
                    arguments: JSON.stringify({ matter_id: workspaceId }),
                    name: "list_matters",
                  },
                },
              ],
            },
            {
              id: "tool-result-1",
              role: "tool",
              toolCallId: "tool-1",
              content: JSON.stringify({
                decisionId: matterRef,
                matters: [{ decisionId: matterRef, id: workspaceId }],
              }),
            },
            {
              id: "activity-1",
              role: "activity",
              activityType: "review",
              content: { matterRef },
            },
          ],
        },
      ),
    );
  });
});

describe("chat message hydration", () => {
  test("refuses stored attachments that cannot be text-hydrated for anonymized third-party sends", async () => {
    const userFileId = toSafeId<"userFile">(
      "11111111-1111-4111-8111-111111111111",
    );
    const threadId = toSafeId<"chatThread">(
      "22222222-2222-4222-8222-222222222222",
    );
    const userId = toSafeId<"user">("33333333-3333-4333-8333-333333333333");
    const { safeDb } = createScopedDbMock({
      query: {
        userFiles: {
          findMany: async () => [
            {
              extractedText: null,
              id: userFileId,
              userId,
              threadId,
              fileName: "draft.pdf",
              mimeType: PDF_MIME_TYPE,
              s3Key: "user/file",
            },
          ],
        },
      },
    });

    const result = await hydrateMessages({
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [
            createChatAttachmentPart({
              filename: "draft.pdf",
              mimeType: PDF_MIME_TYPE,
              url: toUserFileUrl(userFileId),
            }),
          ],
        },
      ],
      safeDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      userId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected PDF hydration refusal");
    }

    if (!("status" in result.error)) {
      throw result.error;
    }

    expect(result.error.status).toBe(422);
  });
});

describe("anonymized outgoing chat stream", () => {
  test("seeds restorations from the current provider-visible message only", () => {
    const placeholders = collectInitialRestorationPlaceholders({
      latestMessageId: "current",
      messages: [
        {
          id: "previous",
          role: "assistant",
          parts: [{ type: "text", content: "Earlier [PERSON_3]" }],
        },
        {
          id: "current",
          role: "user",
          parts: [
            {
              type: "text",
              content: "Does [PERSON_1] involve [PERSON_2]?",
            },
          ],
        },
      ],
      redactionMap: new Map([
        ["[PERSON_1]", "System and user shared name"],
        ["[PERSON_2]", "Current user only"],
        ["[PERSON_3]", "Prior assistant only"],
      ]),
    });

    expect([...placeholders]).toEqual(["[PERSON_1]", "[PERSON_2]"]);
  });

  test("does not emit system-context-only restoration pairs", async () => {
    const boundary = createBoundary([
      ["[PERSON_1]", "System Only"],
      ["[PERSON_2]", "Jan Novak"],
    ]);
    const restorationPairs: ChatAnonRestoration[] = [];
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(["[PERSON_2]"]),
      restorationPairs,
      source: streamChunks([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "text-1",
          delta: "Hello",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "text-1",
        delta: "Hello",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
    ]);
    expect(restorationPairs).toEqual([
      { placeholder: "[PERSON_2]", original: "Jan Novak" },
    ]);
  });

  test("restores non-engine activity snapshot extensions and interrupt bindings", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        unsafeFixture(
          "Unsupported activity role intentionally exercises non-engine snapshot extension preservation",
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [
              {
                id: "message-1",
                role: "assistant",
                content: "Review [PERSON_1]",
              },
              {
                id: "activity-1",
                role: "activity",
                activityType: "review",
                content: { id: "[PERSON_1]", status: "[PERSON_1]" },
              },
            ],
          },
        ),
        {
          type: EventType.RUN_FINISHED,
          threadId: "thread-1",
          runId: "run-1",
          outcome: {
            type: "interrupt",
            interrupts: [
              {
                id: "[PERSON_1]",
                reason: "tool_call",
                metadata: {
                  applicationLabel: "[PERSON_1]",
                  "tanstack:interruptBinding": {
                    originalArgs: {
                      assignee: "[PERSON_1]",
                      id: "[PERSON_1]",
                      name: "[PERSON_1]",
                      nested: { status: "[PERSON_1]", type: "[PERSON_1]" },
                    },
                  },
                  application: { id: "[PERSON_1]", type: "[PERSON_1]" },
                },
              },
            ],
          },
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      unsafeFixture(
        "Unsupported activity role intentionally exercises non-engine snapshot extension preservation",
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: "message-1",
              role: "assistant",
              content: "Review Jan Novak",
            },
            {
              id: "activity-1",
              role: "activity",
              activityType: "review",
              content: { id: "Jan Novak", status: "Jan Novak" },
            },
          ],
        },
      ),
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "[PERSON_1]",
              reason: "tool_call",
              metadata: {
                applicationLabel: "Jan Novak",
                "tanstack:interruptBinding": {
                  originalArgs: {
                    assignee: "Jan Novak",
                    id: "Jan Novak",
                    name: "Jan Novak",
                    nested: { status: "Jan Novak", type: "Jan Novak" },
                  },
                },
                application: { id: "Jan Novak", type: "Jan Novak" },
              },
            },
          ],
        },
      },
    ]);
  });

  test("emits a restoration pair when assistant text uses a placeholder", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "text-1",
          delta: "[PERSON_1]",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "text-1",
        delta: "Jan Novak",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
    ]);
  });

  test("emits a restoration pair when assistant reasoning uses a placeholder", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "reasoning-1",
          delta: "[PERSON_1]",
        },
        { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning-1" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "Jan Novak",
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning-1" },
    ]);
  });

  test("restores bracketless placeholders in user-visible tool input", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        {
          type: EventType.CUSTOM,
          name: "tool-input-available",
          value: {
            toolCallId: "tool_1",
            toolName: "ask-user",
            input: {
              options: ["Call PERSON_1", "Email [PERSON_1]"],
              question: "How should PERSON_1 be contacted?",
            },
          },
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      {
        type: EventType.CUSTOM,
        name: "tool-input-available",
        value: {
          toolCallId: "tool_1",
          toolName: "ask-user",
          input: {
            options: ["Call Jan Novak", "Email Jan Novak"],
            question: "How should Jan Novak be contacted?",
          },
        },
      },
    ]);
  });
});

// A user who types past an ask-user card supersedes the turn: the card's call
// is stored as an error with no result. Handed to the engine as is, that call
// still reads as pending, so the run pauses for the client again and answers
// nothing. The settled history closes it and the model runs. The first test
// is the canary for that engine behaviour: once an upgrade makes it fail, the
// engine no longer needs `closeUnresolvedCallsForEngine`, and both go.
describe("a superseded client-tool call in the engine's history", () => {
  const askUserTool = toolDefinition({
    name: "ask-user",
    description: "Client-rendered clarification",
    inputSchema: toTanStackToolSchema(v.object({ question: v.string() })),
  });
  const supersededHistory: ChatMessage[] = [
    {
      id: "user-1",
      parts: [{ type: "text", content: "Create a document in the matter" }],
      role: "user",
    },
    {
      id: "assistant-1",
      parts: [
        {
          arguments: '{"question":"Which matter?"}',
          id: "call-ask",
          name: "ask-user",
          state: "error",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      id: "user-2",
      parts: [
        {
          type: "text",
          content: "Before you create anything, tell me what it will say.",
        },
      ],
      role: "user",
    },
  ];
  const runOver = async (messages: ChatMessage[]) =>
    await persistNativeInterruptTurn(
      chat({
        adapter: createTextReplyAdapter("It will say one sentence."),
        agentLoopStrategy: maxIterations(3),
        messages,
        threadId: "thread-1",
        tools: [askUserTool],
      }),
    );

  test("canary: the engine ends the raw history with an empty completion", async () => {
    const { finish } = await runOver(supersededHistory);

    expect(finish?.outcome).toEqual({
      error: "empty_completion",
      type: "failed",
    });
  });

  test("the settled history lets the model answer", async () => {
    const { finish } = await runOver(
      settleHistoryForRun({
        messages: supersededHistory,
        resumedMessageId: undefined,
      }),
    );

    expect(finish?.outcome).toEqual({ type: "completed" });
    expect(finish?.responseMessage.parts).toMatchObject([
      { type: "text", content: "It will say one sentence." },
    ]);
  });
});

describe("native visual stream persistence", () => {
  test("preserves issued resources through client-tool continuation and reload", () => {
    const origin = createVisualResourceOrigin();
    const messageId = createSafeId<"chatMessage">();
    const part = origin.issue({
      fileId: createSafeId<"userFile">(),
      title: "Court overview",
      toolCallId: "visual-call",
    });
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => toChatMessage(message, origin),
    });
    const chunks = [
      {
        type: EventType.RUN_STARTED,
        runId: "visual-run",
        threadId: "visual-thread",
      },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: messageId,
        toolCallId: "visual-call",
        toolCallName: "show_visual",
      },
      { type: EventType.CUSTOM, name: "ui-resource", value: part },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: messageId,
        toolCallId: "client-call",
        toolCallName: "client-view",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "client-call",
        delta: "{}",
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "client-call" },
      {
        type: EventType.RUN_FINISHED,
        runId: "visual-run",
        threadId: "visual-thread",
        finishReason: "tool_calls",
      },
    ] as const satisfies readonly StreamChunk[];
    for (const chunk of chunks) {
      capture.processor.processChunk(chunk);
    }
    capture.processor.finalizeStream();
    const persisted =
      capture.message() ?? panic("Visual stream produced no message");
    const streamed =
      capture.processor
        .getMessages()
        .find(({ role }) => role === "assistant") ??
      panic("Visual stream produced no assistant");
    const streamedVisuals = streamed.parts.filter(
      (messagePart) => messagePart.type === "ui-resource",
    );
    expect(streamedVisuals).toEqual([part]);
    expect(
      persisted.parts.filter(
        (messagePart) => messagePart.type === "ui-resource",
      ),
    ).toEqual(streamedVisuals);
    const stored = chatMessageContentFromMessage(
      toPersistableChatMessage({
        id: toSafeId<"chatMessage">(persisted.id),
        role: persisted.role,
        parts: persisted.parts,
      }),
    );
    const reloaded = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">(persisted.id),
      role: persisted.role,
      content: stored,
    });
    expect(
      reloaded.parts.filter(
        (messagePart) => messagePart.type === "ui-resource",
      ),
    ).toEqual(streamedVisuals);
    expect(
      toChatMessage(streamed)?.parts.some(
        (messagePart) => messagePart.type === "ui-resource",
      ) ?? false,
    ).toBe(false);
    expect(
      reloaded.parts.find(
        (messagePart) =>
          messagePart.type === "tool-call" && messagePart.id === "client-call",
      ),
    ).toMatchObject({ state: "input-complete", name: "client-view" });
    const resumedOrigin = createVisualResourceOrigin({
      persistedParts: reloaded.parts,
    });
    const resumed = createStreamMessageCapture({
      initialMessages: [reloaded],
      capture: (message) => toChatMessage(message, resumedOrigin),
    });
    const resumeChunks = [
      {
        type: EventType.RUN_STARTED,
        runId: "visual-resume",
        threadId: "visual-thread",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "client-call",
        messageId: "client-result",
        content: "View selected",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: "Selection received.",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId },
      {
        type: EventType.RUN_FINISHED,
        runId: "visual-resume",
        threadId: "visual-thread",
        finishReason: "stop",
      },
    ] as const satisfies readonly StreamChunk[];
    for (const chunk of resumeChunks) {
      resumed.processor.processChunk(chunk);
    }
    resumed.processor.finalizeStream();
    const resumedMessage =
      resumed.message() ?? panic("Continuation produced no message");
    expect(
      resumedMessage.parts.filter(({ type }) => type === "ui-resource"),
    ).toEqual([part]);
    const resumedContent = chatMessageContentFromMessage(
      toPersistableChatMessage({
        id: toSafeId<"chatMessage">(resumedMessage.id),
        role: resumedMessage.role,
        parts: resumedMessage.parts,
      }),
    );
    const resumedReload = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">(resumedMessage.id),
      role: resumedMessage.role,
      content: resumedContent,
    });
    expect(
      resumedReload.parts.filter(({ type }) => type === "ui-resource"),
    ).toEqual([part]);
    expect(resumedReload.parts).toContainEqual({
      type: "text",
      content: "Selection received.",
    });
  });
});
