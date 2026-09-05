import {
  chat,
  EventType,
  maxIterations,
  normalizeStreamChunk,
  StreamProcessor,
  toolDefinition,
} from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ModelMessage,
  StreamChunk,
  ToolCallPart,
} from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { createPipelineContext } from "@stll/anonymize";
import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  createChatAttachmentPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { CHAT_RUN_MODE } from "@/api/handlers/chat/chat-schema";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { resolveRegistryToolInputRefs } from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import { resolveRegistryToolOutputRefs } from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type {
  ChatAnonRestoration,
  ChatMessage,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatTool } from "@/api/lib/chat/chat-tool-types";
import {
  guardModelMessages,
  guardModelSystemPrompt,
  guardModelToolSchemas,
} from "@/api/lib/chat/model-ingress-guard";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { richChatParts } from "./__fixtures__/rich-chat-parts";
import type { GuardedChatSurfaces } from "./stream-chat";
import {
  chatMessageUsageFromTokenUsage,
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
  ensureAssistantMessageStart,
  normalizeFinalAssistantMessageId,
  remapOutgoingMessageIds,
} from "./stream-message-identity";

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

const scopedDb: ScopedDb = async () => {
  throw new Error("Expected stream deanonymization test not to access DB");
};

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
const createSingleToolCallAdapter = ({
  arguments: argumentsText,
  toolName,
}: {
  arguments: string;
  toolName: string;
}): AnyTextAdapter =>
  createToolCallSequenceAdapter([{ arguments: argumentsText, toolName }]);

/**
 * Answers the n-th model turn with the n-th tool call, so a run can execute a
 * server tool first and pause for a client tool on the next iteration.
 */
const createToolCallSequenceAdapter = (
  turns: readonly { arguments: string; toolName: string }[],
): AnyTextAdapter => {
  let turnIndex = 0;
  return createScriptedAdapter(turns, () => {
    const index = turnIndex;
    turnIndex += 1;
    return index;
  });
};

const createScriptedAdapter = (
  turns: readonly { arguments: string; toolName: string }[],
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
    const { arguments: argumentsText, toolName } = turn;
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
    } satisfies StreamChunk;
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
      } satisfies StreamChunk;
    }
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: callId,
      toolCallName: toolName,
      parentMessageId: messageId,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: callId,
      delta: argumentsText,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId: callId,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      finishReason: "tool_calls",
      model,
      timestamp,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } satisfies StreamChunk;
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

/** Run the loop's emission through the same persistence path as `streamChat`. */
const persistNativeInterruptTurn = async (
  chunks: AsyncIterable<StreamChunk>,
) => {
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
  const emitted = await collectChunks(
    processServerChatStream({
      abortSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      mapMessageId,
      onFinish: (event) => {
        terminal.finish = event;
      },
      processor,
      source: observed(),
    }),
  );
  return { emitted, finish: terminal.finish, source };
};

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
      { toolCallId: "call-1", type: "tool-result" },
      { id: "call-2", name: "create-document", state: "input-complete" },
    ]);
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
          getResponseMessage: () => responseMessage,
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
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [
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
            ],
          },
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
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
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
        ],
      },
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

  test("preserves a persisted owning assistant id at terminal persistence", () => {
    const owningMessageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const replacementMessageId = toSafeId<"chatMessage">(
      "22222222-2222-4222-8222-222222222222",
    );

    expect(
      normalizeFinalAssistantMessageId({
        mapMessageId: createChatMessageIdMapper(() => replacementMessageId),
        message: {
          id: owningMessageId,
          role: "assistant",
          parts: [{ content: "Approved action completed.", type: "text" }],
        },
        preservedMessageId: owningMessageId,
      }).id,
    ).toBe(owningMessageId);
  });

  test("passes the owning assistant id through terminal turn finalization", async () => {
    const owningMessageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const replacementMessageId = toSafeId<"chatMessage">(
      "22222222-2222-4222-8222-222222222222",
    );
    let persistedMessageId: string | undefined;
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      existingMessageIds: new Set([owningMessageId]),
      getResponseMessage: () => ({
        id: owningMessageId,
        role: "assistant",
        parts: [{ content: "Approved action completed.", type: "text" }],
      }),
      mapMessageId: createChatMessageIdMapper(() => replacementMessageId),
      onFinish: ({ responseMessage }) => {
        persistedMessageId = responseMessage.id;
      },
      preservedTerminalMessageId: owningMessageId,
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
      getResponseMessage: () => responseMessage,
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
      getResponseMessage: () => responseMessage,
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
      getResponseMessage: () => responseMessage,
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
      getResponseMessage: () => responseMessage,
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
      getResponseMessage: () => responseMessage,
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
      getResponseMessage: () => null,
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
      {
        type: EventType.RUN_ERROR,
        message: "quota_exhausted",
        code: "quota_exhausted",
        rawEvent: { statusCode: 429 },
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
      getResponseMessage: () => null,
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
      rawEvent: {
        code: "invalid_api_key",
        message: "Incorrect API key",
        param: null,
        type: "invalid_request_error",
      },
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
        getResponseMessage: () => null,
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
        "error.provider.status": "403",
      });
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
        getResponseMessage: () => null,
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
        rawEvent: expect.any(HandlerError),
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
      getResponseMessage: () => null,
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
      getResponseMessage: () => null,
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
      getResponseMessage: () => null,
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
      getResponseMessage: () => null,
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
      rawEvent: { statusCode: 402 },
    });
    expect(outcomes).toEqual(["failed"]);
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

  // A dropped client connection `.return()`s the stream generator mid-run. The
  // metered provider call is decoupled from the socket, so the completed-or-
  // partial content must be persisted (finish reported as not aborted) rather
  // than lost.
  test("persists the accumulated assistant message when the client disconnects mid-stream", async () => {
    const abortSignal = new AbortController().signal;
    const { getResponseMessage, processor } = accumulatingProcessor();
    const finishEvents: { outcome: string; text: string }[] = [];

    const stream = processServerChatStream({
      abortSignal,
      getResponseMessage,
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
      flushPendingSource: persistenceVisible.flushPending,
      getResponseMessage: () => responseMessage,
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
      getResponseMessage,
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
      getResponseMessage,
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
        getResponseMessage: () => responseMessage,
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
      getResponseMessage: () => responseMessage,
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
      messages: guardModelMessages({ messages, workspaceIds }),
      system: guardModelSystemPrompt({ system, workspaceIds }),
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

  test("captures empty stop completions", () => {
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
      usage: {
        completionTokens: 0,
        promptTokens: 12,
        totalTokens: 12,
      },
    });

    expect(state.emptyCompletion).toBeInstanceOf(ChatEmptyCompletionError);
    expect(state.finalLoopDetection).toBeNull();
    expect(capturedErrors).toEqual([state.emptyCompletion]);
  });

  test("surfaces final content loops", () => {
    const state = createChatAttemptState();
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
      usage: {
        completionTokens: 50,
        promptTokens: 12,
        totalTokens: 62,
      },
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
  redactionMap: new Map(pairs),
  scopedDb,
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
      anonymizeFields: async ({ fields }) => ({
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
      getResponseMessage: () => responseMessage,
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
      }),
    );

    expect(persistedInput).toEqual({ matter_id: matterRef });
    const toolCallEnd = clientChunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_END,
    );
    expect(toolCallEnd).toMatchObject({ input: { matter_id: workspaceId } });
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

    expect(snapshot).toEqual({
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
    });
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

  test("restores native AG-UI snapshots and interrupt bindings", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
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
